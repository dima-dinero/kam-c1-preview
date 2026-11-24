/*
 * Haze: soft pearlescent mist over the background of the hero.
 *
 * Look: the smoke of concept B3 translated into the light scene — uneven,
 * cloudy volumes, thick at the sides and low over the floor, thinning towards
 * the centre, slightly luminous where the ring's light reaches it (pink on the
 * left, baby-blue on the right).
 *
 * Motion: the mist fades in at the edges with the intro video, then drifts on its own. A mouse pointer
 * parts and swirls it like a slow fluid; the trace stays for a few seconds
 * and the mist slowly fills back in.
 *
 * How it works (WebGL, no libraries):
 *  - a small "stable fluids" simulation on a low-res grid: advect → divergence
 *    → pressure (Jacobi) → gradient subtract; the flow relaxes towards a slow
 *    curl-noise drift, the pointer pushes it;
 *  - a mist texture (R = density change, GB = texture coordinates, A = base
 *    density). The flow carries the cursor's trail and the cloud pattern.
 *    Both relax slowly back to rest;
 *  - the final pass draws multi-octave, domain-warped noise at those carried
 *    coordinates, shaped by the density, into one canvas inside `.stage`:
 *    above the video and the still, below the phone, text and buttons.
 *
 * Fallbacks: no WebGL (or no float render targets) → static CSS gradients at
 * the edges; reduced motion → one static frame, no pointer; touch → no
 * interaction. The loop pauses when the tab is hidden or the hero is off
 * screen, and drops to a low frame rate when nothing has moved for a while.
 * The layer carries data-haze="webgl2 | webgl1 | css" for a quick check.
 */
(() => {
  const HAZE = {
    // ---------- Look ----------
    maxAlpha: 0.88, // opacity of the thickest mist (at the very edge)
    reachSide: 0.34, // how far mist reaches in from the left/right edge, share of hero width
    reachBottom: 0.3, // from the bottom edge (floor fog), share of hero height
    reachCorner: 0.3, // from the top corners, share of hero height
    cornerStrength: 0.45, // top corners are thinner than the sides
    structure: 0.85, // how uneven the mist is: 0 = flat, 1 = deep gaps between clouds
    cloudScale: 2.2, // size of the clouds: bigger number = smaller clouds
    layering: 1.3, // clouds are stretched horizontally by this factor (layers of smoke)
    color: [0.906, 0.894, 0.953], // thin mist: pale lavender, #E7E4F3
    whiten: 0.7, // thick mist goes towards pure white by this share
    tintLeft: [0.984, 0.878, 0.969], // pearl pink from the left side of the ring
    tintRight: [0.871, 0.933, 0.996], // pearl baby-blue from the right side
    tintStrength: 0.45, // pearl tint over the whole mist (0–1)
    ringGlow: 0.6, // extra light and tint where the mist is near the ring
    textAlpha: 0.85, // mist is multiplied by this over headlines, text and buttons
    phoneClear: 0.3, // and by this around the phone
    feather: 120, // px, soft edge of those protected zones
    reducedAlpha: 0.85, // static mist (reduced motion) is a bit lighter

    // ---------- Intro ----------
    introDuration: 3, // s: the fade finishes on the last moving frame of the video

    // ---------- Ambient motion (no cursor) ----------
    driftSpeed: 18, // px/s, typical speed of the slow drift
    driftScale: 1.4, // size of drift swirls: bigger number = smaller swirls
    driftChange: 0.03, // how fast the drift pattern itself changes
    cloudChange: 0.05, // how fast the clouds change shape on their own
    rise: 4, // px/s, mist slowly rises
    flowRelax: 0.6, // 1/s: flow returns to the ambient drift after a push
    mistRelax: 0.08, // 1/s: parted mist fills back in (0.08 ≈ most of it in ~10 s)
    swirlRelax: 0.12, // 1/s: swirled cloud pattern straightens back

    // ---------- Cursor ----------
    pointerSmoothing: 0.2, // s, low-pass of cursor velocity (higher = softer)
    pointerFollow: 0.12, // s, the push point trails the cursor by this much
    pushStrength: 1.0, // share of the (smoothed) cursor speed handed to the mist
    maxPointerSpeed: 1100, // px/s, faster flicks are capped
    pushRadius: 0.2, // size of the push, share of hero height
    pushResponse: 0.15, // s, how quickly the mist under the cursor picks up the push
    clearRate: 1.8, // 1/s: how fast a moving cursor thins the mist under it
    engageSpeed: 160, // px/s of cursor speed for the full effect (slower = gentler)

    // ---------- Quality and performance ----------
    simResolution: 128, // flow grid, cells on the long side
    dyeResolution: 384, // mist grid, cells on the long side
    touchSimResolution: 96, // on touch-only devices (no interaction there)
    touchDyeResolution: 256,
    renderScale: 0.5, // canvas pixels per CSS pixel (blurry mist: no need for more)
    maxCanvasSide: 1100, // px, cap of the canvas long side
    pressureIterations: 14,
    maxFps: 60, // never update more often (120 Hz screens skip every other frame)
    idleAfter: 8, // s without cursor movement before dropping the frame rate
    idleFps: 24 // update rate when only the ambient drift is moving
  };
  // Ring of the background video (c1 still), in shares of the stage box.
  const RING = { x: 0.493, y: 0.506, radius: 0.203 };

  const hero = document.querySelector(".hero");
  const stage = hero && hero.querySelector(".stage");
  const phoneRig = stage && stage.querySelector(".phone-rig");
  if (!hero || !stage || !phoneRig) return;
  const video = stage.querySelector(".stage-video");

  const touchOnly = window.matchMedia("(any-hover: none)");
  const LIVE_STATES = ["playing", "fallback", "ready"];

  // ---------- Layer: canvas (or CSS fallback) placed over the visible hero ----------

  function placeLayer(element, kind) {
    Object.assign(element.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "0px",
      height: "0px",
      pointerEvents: "none",
      userSelect: "none"
    });
    element.setAttribute("aria-hidden", "true");
    element.className = "haze";
    element.dataset.haze = kind;
    stage.insertBefore(element, phoneRig);
  }

  const box = { w: 0, h: 0, x: 0, y: 0 }; // hero size, and hero origin inside the stage (CSS px)
  const heroRect = { left: 0, top: 0 }; // hero position in the viewport, for the pointer

  function measureBox(element) {
    const h = hero.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    heroRect.left = h.left;
    heroRect.top = h.top;
    box.w = Math.max(1, Math.round(h.width));
    box.h = Math.max(1, Math.round(h.height));
    box.x = h.left - s.left;
    box.y = h.top - s.top;
    element.style.left = box.x + "px";
    element.style.top = box.y + "px";
    element.style.width = box.w + "px";
    element.style.height = box.h + "px";
  }

  // ---------- CSS fallback: static gradients at the edges, one slow fade ----------

  function cssFallback(reason) {
    if (reason) console.warn("haze: static fallback,", reason);
    const layer = document.createElement("div");
    placeLayer(layer, "css");
    const c = "236 233 245";
    Object.assign(layer.style, {
      background: [
        `radial-gradient(ellipse 34% 42% at 0% 0%, rgb(${c} / 30%), transparent)`,
        `radial-gradient(ellipse 34% 42% at 100% 0%, rgb(${c} / 30%), transparent)`,
        `linear-gradient(to right, rgb(251 236 249 / 62%), rgb(${c} / 28%) 16%, transparent 34%)`,
        `linear-gradient(to left, rgb(232 241 253 / 62%), rgb(${c} / 28%) 16%, transparent 34%)`,
        `linear-gradient(to top, rgb(${c} / 55%), rgb(${c} / 18%) 14%, transparent 30%)`
      ].join(","),
      opacity: "0"
    });
    const update = () => measureBox(layer);
    update();
    new ResizeObserver(update).observe(hero);
    window.addEventListener("resize", update);
    let shown = false;
    const sync = () => {
      const state = hero.dataset.intro;
      if (shown) return;
      if (state === "reduced") {
        shown = true;
        layer.style.opacity = String(HAZE.reducedAlpha);
      } else if (LIVE_STATES.includes(state)) {
        shown = true;
        // The only fade of this layer: one ease-out from zero, done when the camera settles.
        layer.style.transition = `opacity ${HAZE.introDuration}s cubic-bezier(.33, 0, .42, 1)`;
        void layer.offsetWidth; // commit opacity 0 first, so the fade always starts from zero
        layer.style.opacity = "1";
      }
    };
    sync();
    new MutationObserver(sync).observe(hero, { attributes: true, attributeFilter: ["data-intro"] });
  }

  // ---------- WebGL ----------

  const canvas = document.createElement("canvas");
  const contextOptions = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "default"
  };
  let gl = canvas.getContext("webgl2", contextOptions);
  const isGL2 = !!gl;
  if (!gl) gl = canvas.getContext("webgl", contextOptions);

  const formats = gl && detectFormats();
  if (!formats) {
    cssFallback(gl ? "no float render targets" : "no WebGL");
    return;
  }

  function detectFormats() {
    let internal, type, linear;
    if (isGL2) {
      if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return null;
      internal = gl.RGBA16F;
      type = gl.HALF_FLOAT;
      linear = true; // half-float filtering is core in WebGL2
    } else {
      const half = gl.getExtension("OES_texture_half_float");
      if (!half) return null;
      gl.getExtension("EXT_color_buffer_half_float");
      internal = gl.RGBA;
      type = half.HALF_FLOAT_OES;
      linear = !!gl.getExtension("OES_texture_half_float_linear");
    }
    // Check that we can actually render into such a texture.
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, gl.RGBA, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return ok ? { internal, type, linear } : null;
  }

  // ---------- Shaders (GLSL ES 1.00: runs in WebGL1 and WebGL2) ----------

  const HEADER = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    ${formats.linear ? "" : "#define MANUAL_FILTER"}
    varying vec2 vUv;
    vec4 sampleLinear(sampler2D t, vec2 uv, vec2 ts) {
    #ifdef MANUAL_FILTER
      vec2 st = uv / ts - 0.5;
      vec2 i = floor(st);
      vec2 f = fract(st);
      vec4 a = texture2D(t, (i + vec2(0.5, 0.5)) * ts);
      vec4 b = texture2D(t, (i + vec2(1.5, 0.5)) * ts);
      vec4 c = texture2D(t, (i + vec2(0.5, 1.5)) * ts);
      vec4 d = texture2D(t, (i + vec2(1.5, 1.5)) * ts);
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    #else
      return texture2D(t, uv);
    #endif
    }
  `;

  // Gradient noise, roughly -1..1.
  const NOISE = `
    vec2 hash22(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
    }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      float a = dot(hash22(i), f);
      float b = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
      float c = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
      float d = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.6;
    }
  `;

  const VERTEX = `
    attribute vec2 aPosition;
    uniform vec2 uTexel;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(uTexel.x, 0.0);
      vR = vUv + vec2(uTexel.x, 0.0);
      vT = vUv + vec2(0.0, uTexel.y);
      vB = vUv - vec2(0.0, uTexel.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  // Flow: self-advection, relax towards the ambient curl-noise drift, cursor push.
  // Velocity is stored in flow-grid cells per second.
  const VELOCITY = HEADER + NOISE + `
    uniform sampler2D uVelocity;
    uniform vec2 uVelTexel;
    uniform float uDt;
    uniform float uTime;
    uniform vec2 uAspect;
    uniform float uDriftScale;
    uniform float uDriftSpeed;
    uniform float uRise;
    uniform float uRelax;
    uniform vec2 uPoint;
    uniform float uRadius2;
    uniform vec2 uPush;
    uniform float uPushMix;
    float potential(vec2 p) {
      return noise(p + vec2(0.0, uTime))
        + 0.5 * noise(p * 2.03 + vec2(uTime * 0.7, -uTime * 0.55) + 7.1);
    }
    void main() {
      vec2 coord = vUv - uDt * texture2D(uVelocity, vUv).xy * uVelTexel;
      vec2 v = sampleLinear(uVelocity, coord, uVelTexel).xy;
      vec2 p = vUv * uAspect * uDriftScale;
      const float e = 0.04;
      float dy = potential(p + vec2(0.0, e)) - potential(p - vec2(0.0, e));
      float dx = potential(p + vec2(e, 0.0)) - potential(p - vec2(e, 0.0));
      vec2 ambient = vec2(dy, -dx) / (2.0 * e) * 0.3 * uDriftSpeed + vec2(0.0, uRise);
      v = mix(v, ambient, uRelax);
      vec2 d = (vUv - uPoint) * uAspect;
      float w = exp(-dot(d, d) / uRadius2);
      v = mix(v, uPush, w * uPushMix);
      gl_FragColor = vec4(v, 0.0, 1.0);
    }
  `;

  const DIVERGENCE = HEADER + `
    uniform sampler2D uVelocity;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    void main() {
      float l = texture2D(uVelocity, vL).x;
      float r = texture2D(uVelocity, vR).x;
      float t = texture2D(uVelocity, vT).y;
      float b = texture2D(uVelocity, vB).y;
      gl_FragColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
    }
  `;

  // Jacobi step. uScale < 1 on the first step fades the previous pressure.
  const PRESSURE = HEADER + `
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    uniform float uScale;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    void main() {
      float l = texture2D(uPressure, vL).x;
      float r = texture2D(uPressure, vR).x;
      float t = texture2D(uPressure, vT).x;
      float b = texture2D(uPressure, vB).x;
      float div = texture2D(uDivergence, vUv).x;
      gl_FragColor = vec4(((l + r + t + b) * uScale - div) * 0.25, 0.0, 0.0, 1.0);
    }
  `;

  const GRADIENT = HEADER + `
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    void main() {
      float l = texture2D(uPressure, vL).x;
      float r = texture2D(uPressure, vR).x;
      float t = texture2D(uPressure, vT).x;
      float b = texture2D(uPressure, vB).x;
      vec2 v = texture2D(uVelocity, vUv).xy - 0.5 * vec2(r - l, t - b);
      gl_FragColor = vec4(v, 0.0, 1.0);
    }
  `;

  // Mist: R = density, GB = cloud texture coordinates. Both are carried by the
  // flow (plus an inward roll during the intro); density relaxes to the edge
  // shape and is thinned under a moving cursor; coordinates relax to rest.
  const MIST = HEADER + NOISE + `
    uniform sampler2D uVelocity;
    uniform sampler2D uMist;
    uniform vec2 uVelTexel;
    uniform vec2 uMistTexel;
    uniform float uDt;
    uniform float uTime;
    uniform vec2 uAspect;
    uniform vec3 uReachSides;
    uniform float uCorner;
    uniform float uRelax;
    uniform float uSwirlRelax;
    uniform vec2 uPoint;
    uniform float uRadius2;
    uniform float uClear;
    float falloff(float x) {
      float s = 1.0 - clamp(x, 0.0, 1.0);
      return s * s * (3.0 - 2.0 * s);
    }
    float source(vec2 uv) {
      vec2 p = uv * uAspect;
      float n = noise(p * 1.4 + vec2(uTime, uTime * 0.4));
      float m = noise(p * 3.1 - vec2(uTime * 0.7, -uTime * 0.9) + 3.7);
      float wob = n * 0.55 + m * 0.25;
      float rs = max(uReachSides.x, 0.001);
      float rb = max(uReachSides.y, 0.001);
      float rc = max(uReachSides.z, 0.001);
      float left = falloff(uv.x / rs + wob * 0.3);
      float right = falloff((1.0 - uv.x) / rs - wob * 0.3);
      float bottom = falloff(uv.y / rb + m * 0.3);
      float cl = falloff(length((uv - vec2(0.0, 1.0)) * uAspect) / rc + wob * 0.3);
      float cr = falloff(length((uv - vec2(1.0, 1.0)) * uAspect) / rc - wob * 0.3);
      float corners = min(1.0, uCorner * (cl + cr));
      float e = 1.0 - (1.0 - left) * (1.0 - right) * (1.0 - bottom) * (1.0 - corners);
      return e * (0.85 + 0.25 * n);
    }
    void main() {
      vec2 flow = sampleLinear(uVelocity, vUv, uVelTexel).xy * uVelTexel;
      vec4 s = sampleLinear(uMist, vUv - uDt * flow, uMistTexel);
      // Advect the cursor trail only. Ambient flow must not pile up density at the edges.
      float base = source(vUv);
      float d = max(base + s.x * (1.0 - uRelax), 0.0);
      vec2 q = (vUv - uPoint) * uAspect;
      d *= 1.0 - uClear * exp(-dot(q, q) / uRadius2);
      vec2 c = mix(s.yz, vUv * uAspect, uSwirlRelax);
      gl_FragColor = vec4(d - base, c, base);
    }
  `;

  // Final picture: domain-warped cloud noise at the carried coordinates,
  // shaped by density, lit near the ring, thinned over text and the phone,
  // premultiplied, dithered against banding.
  const DISPLAY = HEADER + NOISE + `
    uniform sampler2D uMist;
    uniform vec2 uMistTexel;
    uniform float uTime;
    uniform vec2 uSize;
    uniform vec4 uPhone;
    uniform vec3 uRing;
    uniform vec4 uRects[4];
    uniform float uFeather;
    uniform float uTextAlpha;
    uniform float uPhoneClear;
    uniform float uMaxAlpha;
    uniform float uOpacity;
    uniform float uStructure;
    uniform float uCloudScale;
    uniform float uLayering;
    uniform float uWhiten;
    uniform vec3 uColor;
    uniform vec3 uTintLeft;
    uniform vec3 uTintRight;
    uniform float uTintStrength;
    uniform float uRingGlow;
    float rectMask(vec2 p, vec4 r) {
      if (r.z <= r.x) return 0.0;
      vec2 c = (r.xy + r.zw) * 0.5;
      vec2 q = abs(p - c) - (r.zw - r.xy) * 0.5;
      float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      return 1.0 - smoothstep(0.0, uFeather, d);
    }
    float clouds(vec2 q, float t) {
      vec2 warp = vec2(noise(q * 0.6 + vec2(t * 0.5, 1.7)), noise(q * 0.6 + vec2(4.1, -t * 0.4)));
      q += warp * 0.9;
      float f = 0.5 * noise(q + vec2(t * 0.35, 0.0));
      f += 0.25 * noise(q * 2.03 + vec2(-t * 0.25, t * 0.2) + 5.3);
      f += 0.14 * noise(q * 4.07 + vec2(t * 0.4, -t * 0.3) + 9.1);
      f += 0.07 * noise(q * 8.11 - vec2(t * 0.5, 0.0) + 2.4);
      return clamp(f * 0.9 + 0.5, 0.0, 1.0);
    }
    void main() {
      vec4 s = sampleLinear(uMist, vUv, uMistTexel);
      float d = max(s.x + s.w, 0.0);
      vec2 q = s.yz * uCloudScale * vec2(1.0, uLayering);
      float c = clouds(q, uTime);
      // Uneven, cloudy density: dense patches and thinner gaps.
      float cloud = smoothstep(0.22, 0.82, c);
      float m = d * mix(1.0, 0.12 + 1.6 * cloud, uStructure);
      vec2 px = vUv * uSize;
      // Light from the ring: mist close to it glows a little.
      float rd = (length(px - uRing.xy) - uRing.z) / (uRing.z * 0.55);
      float glow = exp(-rd * rd) * uRingGlow;
      float cover = 0.0;
      for (int i = 0; i < 4; i++) cover = max(cover, rectMask(px, uRects[i]));
      float shield = mix(1.0, uTextAlpha, cover);
      float pd = length((px - uPhone.xy) / max(uPhone.zw, vec2(1.0)));
      shield *= mix(uPhoneClear, 1.0, smoothstep(0.75, 1.4, pd));
      float dense = clamp(m, 0.0, 1.4);
      float a = uMaxAlpha * min(1.0, (1.0 - exp(-1.2 * dense)) / (1.0 - exp(-1.2 * 1.15)));
      a = min(a * (1.0 + 0.35 * glow), 0.92) * shield;
      float side = smoothstep(0.15, 0.85, vUv.x);
      vec3 tint = mix(uTintLeft, uTintRight, side);
      vec3 col = mix(uColor, tint, clamp(uTintStrength + glow * 0.6, 0.0, 1.0));
      col = mix(col, vec3(1.0), clamp(smoothstep(0.15, 1.1, dense) * uWhiten + glow * 0.35, 0.0, 1.0));
      vec3 p3 = fract(vec3(gl_FragCoord.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      a = clamp(a + (fract((p3.x + p3.y) * p3.z) - 0.5) / 255.0, 0.0, 1.0) * uOpacity;
      gl_FragColor = vec4(col * a, a);
    }
  `;

  const COPY = HEADER + `
    uniform sampler2D uSource;
    uniform vec2 uSourceTexel;
    void main() { gl_FragColor = sampleLinear(uSource, vUv, uSourceTexel); }
  `;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error("shader: " + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  let vertexShader;
  function program(fragment) {
    const p = gl.createProgram();
    gl.attachShader(p, vertexShader);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(p, 0, "aPosition");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error("program: " + gl.getProgramInfoLog(p));
    }
    const u = {};
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(p, i).name.replace("[0]", "");
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  let programs;
  function createPrograms() {
    vertexShader = compile(gl.VERTEX_SHADER, VERTEX);
    programs = {
      velocity: program(VELOCITY),
      divergence: program(DIVERGENCE),
      pressure: program(PRESSURE),
      gradient: program(GRADIENT),
      mist: program(MIST),
      display: program(DISPLAY),
      copy: program(COPY)
    };
    // One triangle that covers the whole viewport.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
  }

  // ---------- Render targets ----------

  function target(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const filter = formats.linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, formats.internal, w, h, 0, gl.RGBA, formats.type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h, tx: 1 / w, ty: 1 / h };
  }

  function pair(w, h) {
    return {
      read: target(w, h),
      write: target(w, h),
      swap() { const t = this.read; this.read = this.write; this.write = t; }
    };
  }

  function free(t) {
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  // Bind a texture to a unit and return the unit number for the sampler uniform.
  function bind(t, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    return unit;
  }

  function draw(destination) {
    if (destination) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, destination.fbo);
      gl.viewport(0, 0, destination.w, destination.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function gridSize(resolution) {
    const long = Math.max(box.w, box.h);
    const short = Math.min(box.w, box.h);
    const b = Math.max(16, Math.round((resolution * short) / long));
    return box.w >= box.h ? [resolution, b] : [b, resolution];
  }

  let velocity, pressure, divergence, mist;

  // Resample an old pair into a new size, so a resize does not reset the mist.
  function resized(old, w, h) {
    const next = pair(w, h);
    if (old) {
      const c = programs.copy;
      gl.useProgram(c.p);
      gl.uniform2f(c.u.uTexel, next.read.tx, next.read.ty);
      gl.uniform2f(c.u.uSourceTexel, old.read.tx, old.read.ty);
      gl.uniform1i(c.u.uSource, bind(old.read, 0));
      draw(next.read);
      free(old.read);
      free(old.write);
    }
    return next;
  }

  function allocate() {
    const touch = touchOnly.matches;
    const [sw, sh] = gridSize(touch ? HAZE.touchSimResolution : HAZE.simResolution);
    const [dw, dh] = gridSize(touch ? HAZE.touchDyeResolution : HAZE.dyeResolution);
    if (!velocity || velocity.read.w !== sw || velocity.read.h !== sh) {
      velocity = resized(velocity, sw, sh);
      if (pressure) { free(pressure.read); free(pressure.write); free(divergence); }
      pressure = pair(sw, sh);
      divergence = target(sw, sh);
    }
    if (!mist || mist.read.w !== dw || mist.read.h !== dh) {
      const fresh = !mist;
      mist = resized(mist, dw, dh);
      if (fresh) mistPass(0, 0, 1, 1); // settle the density before the first visible frame
    }
  }

  // ---------- Layout: size, protected zones, ring ----------

  const rects = new Float32Array(16); // up to 4 text zones: x0, y0, x1, y1 in hero px, y up
  const phoneZone = new Float32Array(4); // centre x, y and radii in hero px, y up
  const ring = new Float32Array(3); // ring centre x, y (y up) and mid radius, hero px
  const textSelectors = [".headline-left", ".headline-right", ".description", ".hero-actions"];

  function measureZones() {
    const h = hero.getBoundingClientRect();
    for (let i = 0; i < 4; i++) {
      const element = hero.querySelector(textSelectors[i]);
      const r = element && element.getClientRects().length ? element.getBoundingClientRect() : null;
      if (!r || r.width === 0) {
        rects[i * 4] = rects[i * 4 + 2] = 0;
        continue;
      }
      rects[i * 4] = r.left - h.left;
      rects[i * 4 + 1] = h.bottom - r.bottom;
      rects[i * 4 + 2] = r.right - h.left;
      rects[i * 4 + 3] = h.bottom - r.top;
    }
    // The rig does not move during the intro (the phone inside it does).
    const p = phoneRig.getBoundingClientRect();
    phoneZone[0] = p.left + p.width / 2 - h.left;
    phoneZone[1] = h.bottom - (p.top + p.height / 2);
    phoneZone[2] = p.width * 0.85;
    phoneZone[3] = p.height * 0.6;
    const s = stage.getBoundingClientRect();
    ring[0] = s.left + s.width * RING.x - h.left;
    ring[1] = h.bottom - (s.top + s.height * RING.y);
    ring[2] = s.width * RING.radius;
  }

  function measure() {
    measureBox(canvas);
    const long = Math.max(box.w, box.h);
    const scale = Math.min(HAZE.renderScale, HAZE.maxCanvasSide / long);
    const cw = Math.max(1, Math.round(box.w * scale));
    const ch = Math.max(1, Math.round(box.h * scale));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    measureZones();
    allocate();
  }

  // ---------- Pointer: smoothed position and velocity ----------

  const pointer = {
    inside: false,
    x: 0, y: 0, // latest raw position, hero px
    px: 0, py: 0, // raw position at the previous frame
    sx: 0, sy: 0, // smoothed (trailing) position
    vx: 0, vy: 0, // smoothed velocity, px/s
    fresh: true
  };
  let lastActivity = performance.now();

  function onPointerMove(event) {
    if (event.pointerType === "touch" || mode !== "live") return;
    const x = event.clientX - heroRect.left;
    const y = event.clientY - heroRect.top;
    const inside = x >= 0 && y >= 0 && x <= box.w && y <= box.h;
    if (inside && !pointer.inside) pointer.fresh = true;
    pointer.inside = inside;
    pointer.x = x;
    pointer.y = y;
    lastActivity = performance.now();
    wake();
  }

  function onPointerLeave() {
    pointer.inside = false;
  }

  function updatePointer(dt) {
    if (pointer.fresh) {
      // Entering the hero is not a flick: start at rest where the cursor is.
      pointer.px = pointer.sx = pointer.x;
      pointer.py = pointer.sy = pointer.y;
      pointer.fresh = false;
    }
    let rawX = 0;
    let rawY = 0;
    if (pointer.inside) {
      rawX = (pointer.x - pointer.px) / dt;
      rawY = (pointer.y - pointer.py) / dt;
    }
    pointer.px = pointer.x;
    pointer.py = pointer.y;
    const speed = Math.hypot(rawX, rawY);
    if (speed > HAZE.maxPointerSpeed) {
      rawX *= HAZE.maxPointerSpeed / speed;
      rawY *= HAZE.maxPointerSpeed / speed;
    }
    const kv = 1 - Math.exp(-dt / HAZE.pointerSmoothing);
    pointer.vx += (rawX - pointer.vx) * kv;
    pointer.vy += (rawY - pointer.vy) * kv;
    const kp = 1 - Math.exp(-dt / HAZE.pointerFollow);
    pointer.sx += (pointer.x - pointer.sx) * kp;
    pointer.sy += (pointer.y - pointer.sy) * kp;
  }

  // 0..1: how much the cursor is moving right now (a resting cursor does nothing).
  function engagement() {
    if (!pointer.inside) return 0;
    return Math.min(1, Math.hypot(pointer.vx, pointer.vy) / HAZE.engageSpeed);
  }

  // ---------- Simulation step and drawing ----------

  const clock = { time: 0, intro: 0 }; // s

  function introOpacity() {
    // A soft start, with most of the fade in the first half of the camera move.
    if (clock.intro >= HAZE.introDuration) return 1;
    const t = clock.intro / HAZE.introDuration;
    const remaining = 1 - t;
    return 1 - remaining ** 3 * (1 + 3 * t);
  }

  function mistPass(dt, t, relax, swirlRelax) {
    const v = programs.mist;
    gl.useProgram(v.p);
    gl.uniform2f(v.u.uTexel, mist.read.tx, mist.read.ty);
    gl.uniform1i(v.u.uVelocity, bind(velocity.read, 0));
    gl.uniform1i(v.u.uMist, bind(mist.read, 1));
    gl.uniform2f(v.u.uVelTexel, velocity.read.tx, velocity.read.ty);
    gl.uniform2f(v.u.uMistTexel, mist.read.tx, mist.read.ty);
    gl.uniform1f(v.u.uDt, dt);
    gl.uniform1f(v.u.uTime, t);
    gl.uniform2f(v.u.uAspect, box.w / box.h, 1);
    gl.uniform3f(v.u.uReachSides, HAZE.reachSide, HAZE.reachBottom, HAZE.reachCorner);
    gl.uniform1f(v.u.uCorner, HAZE.cornerStrength);
    gl.uniform1f(v.u.uRelax, relax);
    gl.uniform1f(v.u.uSwirlRelax, swirlRelax);
    gl.uniform2f(v.u.uPoint, pointer.sx / box.w, 1 - pointer.sy / box.h);
    gl.uniform1f(v.u.uRadius2, HAZE.pushRadius * HAZE.pushRadius);
    gl.uniform1f(v.u.uClear, dt > 0 ? (1 - Math.exp(-dt * HAZE.clearRate)) * engagement() : 0);
    draw(mist.write);
    mist.swap();
  }

  function step(dt) {
    clock.time += dt;
    const t = (clock.time % 4000) * HAZE.driftChange;
    const aspect = box.w / box.h;
    const cellsPerPx = velocity.read.w / box.w; // flow cells are square

    // Flow: advect, drift, push.
    let v = programs.velocity;
    gl.useProgram(v.p);
    gl.uniform2f(v.u.uTexel, velocity.read.tx, velocity.read.ty);
    gl.uniform1i(v.u.uVelocity, bind(velocity.read, 0));
    gl.uniform2f(v.u.uVelTexel, velocity.read.tx, velocity.read.ty);
    gl.uniform1f(v.u.uDt, dt);
    gl.uniform1f(v.u.uTime, t);
    gl.uniform2f(v.u.uAspect, aspect, 1);
    gl.uniform1f(v.u.uDriftScale, HAZE.driftScale);
    gl.uniform1f(v.u.uDriftSpeed, HAZE.driftSpeed * cellsPerPx);
    gl.uniform1f(v.u.uRise, HAZE.rise * cellsPerPx);
    gl.uniform1f(v.u.uRelax, 1 - Math.exp(-dt * HAZE.flowRelax));
    gl.uniform2f(v.u.uPoint, pointer.sx / box.w, 1 - pointer.sy / box.h);
    gl.uniform1f(v.u.uRadius2, HAZE.pushRadius * HAZE.pushRadius);
    const k = HAZE.pushStrength * cellsPerPx;
    gl.uniform2f(v.u.uPush, pointer.vx * k, -pointer.vy * k);
    gl.uniform1f(v.u.uPushMix, (1 - Math.exp(-dt / HAZE.pushResponse)) * engagement());
    draw(velocity.write);
    velocity.swap();

    // Make the flow divergence-free: swirls instead of sources and sinks.
    v = programs.divergence;
    gl.useProgram(v.p);
    gl.uniform2f(v.u.uTexel, velocity.read.tx, velocity.read.ty);
    gl.uniform1i(v.u.uVelocity, bind(velocity.read, 0));
    draw(divergence);

    v = programs.pressure;
    gl.useProgram(v.p);
    gl.uniform2f(v.u.uTexel, velocity.read.tx, velocity.read.ty);
    gl.uniform1i(v.u.uDivergence, bind(divergence, 1));
    for (let i = 0; i < HAZE.pressureIterations; i++) {
      gl.uniform1f(v.u.uScale, i === 0 ? 0.8 : 1);
      gl.uniform1i(v.u.uPressure, bind(pressure.read, 0));
      draw(pressure.write);
      pressure.swap();
    }

    v = programs.gradient;
    gl.useProgram(v.p);
    gl.uniform2f(v.u.uTexel, velocity.read.tx, velocity.read.ty);
    gl.uniform1i(v.u.uPressure, bind(pressure.read, 0));
    gl.uniform1i(v.u.uVelocity, bind(velocity.read, 1));
    draw(velocity.write);
    velocity.swap();

    mistPass(dt, t, 1 - Math.exp(-dt * HAZE.mistRelax), 1 - Math.exp(-dt * HAZE.swirlRelax));
  }

  function render(alpha) {
    const v = programs.display;
    gl.useProgram(v.p);
    gl.uniform2f(v.u.uTexel, 1 / canvas.width, 1 / canvas.height);
    gl.uniform1i(v.u.uMist, bind(mist.read, 0));
    gl.uniform2f(v.u.uMistTexel, mist.read.tx, mist.read.ty);
    gl.uniform1f(v.u.uTime, (clock.time % 4000) * HAZE.cloudChange);
    gl.uniform2f(v.u.uSize, box.w, box.h);
    gl.uniform4fv(v.u.uPhone, phoneZone);
    gl.uniform3fv(v.u.uRing, ring);
    gl.uniform4fv(v.u.uRects, rects);
    gl.uniform1f(v.u.uFeather, HAZE.feather);
    gl.uniform1f(v.u.uTextAlpha, HAZE.textAlpha);
    gl.uniform1f(v.u.uPhoneClear, HAZE.phoneClear);
    gl.uniform1f(v.u.uMaxAlpha, HAZE.maxAlpha);
    gl.uniform1f(v.u.uOpacity, alpha);
    gl.uniform1f(v.u.uStructure, HAZE.structure);
    gl.uniform1f(v.u.uCloudScale, HAZE.cloudScale);
    gl.uniform1f(v.u.uLayering, HAZE.layering);
    gl.uniform1f(v.u.uWhiten, HAZE.whiten);
    gl.uniform3f(v.u.uColor, HAZE.color[0], HAZE.color[1], HAZE.color[2]);
    gl.uniform3f(v.u.uTintLeft, HAZE.tintLeft[0], HAZE.tintLeft[1], HAZE.tintLeft[2]);
    gl.uniform3f(v.u.uTintRight, HAZE.tintRight[0], HAZE.tintRight[1], HAZE.tintRight[2]);
    gl.uniform1f(v.u.uTintStrength, HAZE.tintStrength);
    gl.uniform1f(v.u.uRingGlow, HAZE.ringGlow);
    draw(null);
  }

  // ---------- Loop: runs only once the intro has started and the hero is visible ----------

  let mode = "off"; // off | live | static
  let visible = true;
  let raf = 0;
  let lastTime = 0;

  function wake() {
    if (raf || mode !== "live" || !visible || document.hidden) return;
    lastTime = performance.now();
    raf = window.requestAnimationFrame(frame);
  }

  function sleep() {
    window.cancelAnimationFrame(raf);
    raf = 0;
  }

  function frame(now) {
    raf = window.requestAnimationFrame(frame);
    const introducing = clock.intro < HAZE.introDuration;
    const idle = !introducing && now - lastActivity > HAZE.idleAfter * 1000;
    const minStep = 1000 / (idle ? HAZE.idleFps : HAZE.maxFps);
    const elapsed = now - lastTime;
    if (elapsed < minStep * 0.9) return;
    lastTime = now;
    if (introducing) {
      // The fade follows the video even when the fluid simulation drops frames.
      // Without video, count only the time the hero is visible.
      const time = video?.classList.contains("is-visible") ? video.currentTime : clock.intro + elapsed / 1000;
      clock.intro = Math.min(HAZE.introDuration, Math.max(clock.intro, time));
    }
    const dt = Math.min(elapsed / 1000, 1 / 15);
    updatePointer(dt);
    step(dt);
    render(introOpacity());
  }

  function drawStatic() {
    sleep();
    mistPass(0, 0, 1, 1); // mist set straight to its edge shape
    render(HAZE.reducedAlpha);
  }

  function syncState() {
    const state = hero.dataset.intro;
    if (state === "reduced") {
      mode = "static";
      drawStatic();
      return;
    }
    if (LIVE_STATES.includes(state)) {
      if (mode !== "live") {
        if (mode === "static") clock.intro = HAZE.introDuration;
        mode = "live";
        lastActivity = performance.now();
        wake();
      }
    }
  }

  // ---------- Start ----------

  try {
    placeLayer(canvas, isGL2 ? "webgl2" : "webgl1");
    createPrograms();
    measure();
  } catch (error) {
    canvas.remove();
    cssFallback(error && error.message);
    return;
  }

  let measureQueued = 0;
  function remeasure() {
    if (measureQueued) return;
    measureQueued = window.requestAnimationFrame(() => {
      measureQueued = 0;
      if (gl.isContextLost()) return;
      measure();
      if (mode === "static") drawStatic();
      // A new canvas size clears it: redraw now, so the mist never blinks out for a frame.
      else if (mode === "live") render(introOpacity());
    });
  }

  const resizeObserver = new ResizeObserver(remeasure);
  resizeObserver.observe(hero);
  resizeObserver.observe(stage);
  for (const selector of textSelectors) {
    const element = hero.querySelector(selector);
    if (element) resizeObserver.observe(element);
  }
  window.addEventListener("resize", remeasure);
  window.addEventListener("scroll", () => {
    const h = hero.getBoundingClientRect();
    heroRect.left = h.left;
    heroRect.top = h.top;
  }, { passive: true });
  if (document.fonts) document.fonts.ready.then(remeasure);

  // On window, so the header, buttons and phone never block it.
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("blur", onPointerLeave);

  new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) wake();
    else sleep();
  }).observe(hero);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) sleep();
    else wake();
  });

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    sleep();
    mode = "off";
    canvas.style.visibility = "hidden";
  });
  canvas.addEventListener("webglcontextrestored", () => {
    velocity = pressure = divergence = mist = null;
    createPrograms();
    measure();
    canvas.style.visibility = "";
    syncState();
  });

  new MutationObserver(syncState).observe(hero, { attributes: true, attributeFilter: ["data-intro"] });
  syncState();
})();
