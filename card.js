/*
 * Club card in the phone: on hover the card turns toward the pointer like a
 * real metal card in the hand, and the glare slides with the tilt.
 *  - Every value follows its target with a critically damped spring
 *    (smooth start, smooth stop, no overshoot), frame-rate independent.
 *  - One rAF loop, only while something still moves; at rest nothing runs
 *    and the 3D transform is removed, so the card is painted flat and crisp.
 *  - Only for a real mouse, only after the intro, never with reduced motion
 *    (then the card keeps its static resting glare from the CSS).
 */
(() => {
  const CARD = {
    maxTilt: 8, // deg at the card edge (rotateX / rotateY)
    followTime: 0.22, // s, smoothing while the pointer is over the card
    returnTime: 0.45, // s, smoothing back to rest after the pointer leaves
    glareTravel: 0.6, // share of the card the glare spot travels from its centre
    glareHover: 1, // glare strength under the pointer (rest: --glare in CSS)
    rest: { gx: 22, gy: 8, glare: 0.5 }, // % / %, same as the CSS resting light
    settle: { angle: 0.02, percent: 0.1, glare: 0.005 }, // closer than this counts as arrived (deg, %, share)
  };

  const card = document.querySelector(".app-club");
  const hero = document.querySelector(".hero");
  if (!card || !hero) return;

  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Channels: current value, velocity, target and the step that counts as arrived.
  const make = (value, settle) => ({ value, velocity: 0, target: value, settle });
  const state = {
    rx: make(0, CARD.settle.angle),
    ry: make(0, CARD.settle.angle),
    gx: make(CARD.rest.gx, CARD.settle.percent),
    gy: make(CARD.rest.gy, CARD.settle.percent),
    glare: make(CARD.rest.glare, CARD.settle.glare),
    shift: make(0, CARD.settle.glare),
  };

  let enabled = false;
  let hovering = false;
  let frame = 0;
  let last = 0;
  let rect = null;

  // Critically damped spring step (as Unity's SmoothDamp): never overshoots the target.
  function damp(channel, smoothTime, dt) {
    const omega = 2 / smoothTime;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = channel.value - channel.target;
    const temp = (channel.velocity + omega * change) * dt;
    let velocity = (channel.velocity - omega * temp) * decay;
    let value = channel.target + (change + temp) * decay;
    if ((channel.target - channel.value > 0) === (value > channel.target)) {
      value = channel.target;
      velocity = 0;
    }
    channel.value = value;
    channel.velocity = velocity;
  }

  function write() {
    const s = card.style;
    s.setProperty("--rx", state.rx.value.toFixed(3) + "deg");
    s.setProperty("--ry", state.ry.value.toFixed(3) + "deg");
    s.setProperty("--gx", state.gx.value.toFixed(2) + "%");
    s.setProperty("--gy", state.gy.value.toFixed(2) + "%");
    s.setProperty("--glare", state.glare.value.toFixed(3));
    s.setProperty("--shift", state.shift.value.toFixed(3));
  }

  function settled() {
    return Object.values(state).every((c) =>
      Math.abs(c.value - c.target) < c.settle && Math.abs(c.velocity) < c.settle * 10);
  }

  function tick(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30); // a long frame must not make a jump
    last = now;
    const smoothTime = hovering ? CARD.followTime : CARD.returnTime;
    for (const channel of Object.values(state)) damp(channel, smoothTime, dt);

    if (settled()) {
      for (const channel of Object.values(state)) {
        channel.value = channel.target;
        channel.velocity = 0;
      }
      write();
      frame = 0;
      if (!hovering) card.classList.remove("is-tilting"); // flat again: crisp, no extra layer
      return;
    }
    write();
    frame = requestAnimationFrame(tick);
  }

  function start() {
    card.classList.add("is-tilting");
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function aim(event) {
    rect ??= card.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1));
    // The card faces the pointer: the side under it turns away from the viewer.
    state.ry.target = nx * CARD.maxTilt;
    state.rx.target = -ny * CARD.maxTilt;
    state.gx.target = 50 + nx * CARD.glareTravel * 50;
    state.gy.target = 50 + ny * CARD.glareTravel * 50;
    state.glare.target = CARD.glareHover;
    state.shift.target = -nx;
    start();
  }

  function rest() {
    state.rx.target = 0;
    state.ry.target = 0;
    state.gx.target = CARD.rest.gx;
    state.gy.target = CARD.rest.gy;
    state.glare.target = CARD.rest.glare;
    state.shift.target = 0;
  }

  card.addEventListener("pointerenter", (event) => {
    if (!enabled || event.pointerType !== "mouse") return;
    hovering = true;
    rect = card.getBoundingClientRect();
    aim(event);
  });
  card.addEventListener("pointermove", (event) => {
    if (enabled && hovering) aim(event);
  });
  card.addEventListener("pointerleave", () => {
    if (!hovering) return;
    hovering = false;
    rest();
    start();
  });
  // The card box never moves by itself; only the page can move it.
  const forget = () => { rect = null; };
  window.addEventListener("resize", forget, { passive: true });
  window.addEventListener("scroll", forget, { passive: true });

  function update() {
    const next = canHover.matches && !reducedMotion.matches && hero.dataset.intro === "ready";
    if (next === enabled) return;
    enabled = next;
    card.classList.toggle("is-interactive", enabled);
    if (!enabled) {
      // Back to the static resting light at once.
      cancelAnimationFrame(frame);
      frame = 0;
      hovering = false;
      rest();
      for (const channel of Object.values(state)) {
        channel.value = channel.target;
        channel.velocity = 0;
      }
      card.classList.remove("is-tilting");
      card.style.cssText = "";
    }
  }

  new MutationObserver(update).observe(hero, { attributes: true, attributeFilter: ["data-intro"] });
  canHover.addEventListener("change", update);
  reducedMotion.addEventListener("change", update);
  update();
})();
