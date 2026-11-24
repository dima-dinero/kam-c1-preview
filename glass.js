/*
 * Liquid Glass, in two tiers.
 *
 * Tier 1 — every browser (CSS only, styles.css `.glass`): frosted backdrop
 * (blur + saturate), light tint, rim highlights from inset shadows.
 *
 * Tier 2 — Chromium only: real refraction at the rim. An SVG filter with a
 * displacement map, plugged into `backdrop-filter: url(#…)`. Safari and
 * Firefox parse that value but draw nothing (Firefox even drops the whole
 * property), and `@supports` cannot tell, so we only switch it on after
 * checking the engine and after the filter is in the DOM (otherwise Chromium
 * flashes the element transparent on load).
 *
 * The map is built once per element size (pills only: radius = height / 2)
 * and rebuilt on resize. Nothing runs per frame, so the cost is one small
 * canvas per glass element plus the browser's filter pass.
 */
(() => {
  const isChromium = navigator.userAgentData?.brands?.some((b) => b.brand === "Chromium");
  const lessGlass = window.matchMedia("(prefers-reduced-transparency: reduce)");
  if (!isChromium || lessGlass.matches) return;

  const SVG = "http://www.w3.org/2000/svg";
  const host = document.createElementNS(SVG, "svg");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("width", "0");
  host.setAttribute("height", "0");
  host.style.position = "absolute";
  document.body.append(host);

  // Convex squircle profile of the glass edge: 0 at the rim, 1 where the top turns flat.
  const height = (x) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4);
  // Refraction follows the slope of the surface; normalised to 1 at the rim.
  const slope = (x) => (height(Math.min(1, x + 0.01)) - height(x)) / 0.01;
  const SLOPE_MAX = slope(0.02);
  const strength = (x) => (x >= 1 ? 0 : Math.min(1, slope(Math.max(x, 0.02)) / SLOPE_MAX));

  // Displacement map of a pill: R = x shift, G = y shift, 128 = none. Rays bend inwards.
  function buildMap(w, h, bezel) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(w, h);
    const r = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const cx = Math.min(Math.max(px, r), w - r);
        const dx = px - cx;
        const dy = py - r;
        const len = Math.hypot(dx, dy) || 1;
        const inside = r - len; // distance from the rim
        const m = inside < 0 ? 0 : strength(inside / bezel);
        const i = (y * w + x) * 4;
        img.data[i] = 128 - (dx / len) * m * 127;
        img.data[i + 1] = 128 - (dy / len) * m * 127;
        img.data[i + 2] = 128;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }

  function attach(element, index) {
    const id = "liquid-glass-" + index;
    const filter = document.createElementNS(SVG, "filter");
    filter.id = id;
    filter.setAttribute("color-interpolation-filters", "sRGB"); // keep map values as they are
    filter.setAttribute("filterUnits", "userSpaceOnUse");
    filter.setAttribute("primitiveUnits", "userSpaceOnUse");
    filter.innerHTML =
      '<feGaussianBlur in="SourceGraphic" result="soft"/>' +
      '<feImage result="map" preserveAspectRatio="none"/>' +
      '<feDisplacementMap in="soft" in2="map" xChannelSelector="R" yChannelSelector="G"/>';
    host.append(filter);
    const [blur, image, displace] = filter.children;
    let size = "";

    const update = () => {
      const w = Math.round(element.offsetWidth);
      const h = Math.round(element.offsetHeight);
      if (!w || !h || size === w + "x" + h) return;
      size = w + "x" + h;
      const bezel = Math.min(h * 0.42, 28); // width of the curved rim, px
      for (const node of [filter, image]) {
        node.setAttribute("x", "0");
        node.setAttribute("y", "0");
        node.setAttribute("width", w);
        node.setAttribute("height", h);
      }
      image.setAttribute("href", buildMap(w, h, bezel));
      blur.setAttribute("stdDeviation", element.dataset.glassBlur || "1.5");
      displace.setAttribute("scale", element.dataset.glassRefraction || Math.round(h * 0.5));
      element.style.setProperty("--glass-filter", "url(#" + id + ")");
    };

    update();
    new ResizeObserver(update).observe(element);
  }

  document.querySelectorAll(".glass").forEach(attach);
  // Only now, with every filter in the DOM, let CSS use them.
  document.documentElement.dataset.glass = "refract";
  lessGlass.addEventListener?.("change", () => location.reload());
})();
