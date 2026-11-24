(() => {
  const hero = document.querySelector(".hero");
  const video = hero.querySelector(".stage-video");
  const dialog = document.querySelector(".preview-dialog");
  const dialogTitle = dialog.querySelector("h2");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const animator = window.gsap;

  for (const control of document.querySelectorAll("[data-demo]")) {
    control.addEventListener("click", () => {
      dialogTitle.textContent = control.getAttribute("aria-label") || control.textContent.trim();
      dialog.showModal();
    });
  }

  if (!animator) {
    hero.dataset.intro = "ready";
    return;
  }

  /*
   * One scene, one clock. Every element lives on a single timeline measured
   * in seconds of the background video (3.04 s). While the video plays, the
   * timeline runs on its own smooth clock and is only nudged back if the
   * video drifts or stalls. The video peaks in motion at ~0.5 s and slowly
   * settles until ~3 s, so all moves use long ease-outs that land together
   * with the camera.
   */
  const TIME = {
    phone: 1.0, // phone rises from below while the camera is still pulling back
    titleLeft: 1.65,
    titleRight: 1.73,
    header: 2.0,
    screen: 1.9, // figures inside the phone fill up as it settles
    description: 2.3,
    actions: 2.4
  };
  const START_TIMEOUT = 2500; // ms to wait for the video before playing over the still
  const FALLBACK_FROM = 0.9; // where the timeline starts when there is no video
  const VIDEO_END = 3.0; // time of the last video frame
  const MAX_DRIFT = 0.12; // s of difference with the video before we re-sync
  const VIDEO_FPS = 24; // frame rate of intro.mp4
  // Phone cadence: 2 steps per video frame = 48 fps (the camera is 24 fps).
  const PHONE_STEPS = 2;

  const interactive = [hero.querySelector(".masthead"), hero.querySelector(".hero-actions")];
  let sequence; // interface layer: headline, header, text, buttons — smooth, on the screen's refresh rate
  let phoneMotion; // the phone belongs to the scene: it is stepped from the video's own frames
  let lastFrame = { time: 0, at: 0 }; // last presented video frame: media time and performance.now()
  let run = 0;
  let frame = 0;
  let timer = 0;

  const all = (selector) => [...hero.querySelectorAll(selector)];
  const visible = (elements) => elements.filter((element) => element.getClientRects().length > 0);

  function setControls(inert) {
    for (const group of interactive) group.inert = inert;
  }

  function stopUpdates() {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  }

  function buildSequence() {
    const compact = getComputedStyle(hero.querySelector(".headline")).position !== "absolute";
    const shift = hero.clientWidth * (compact ? 0.14 : 0.06);
    const phone = hero.querySelector(".phone");
    const leftLines = all(".headline-left .headline-line");
    const rightLines = all(".headline-right .headline-line");
    const header = hero.querySelector(".masthead");
    const headerItems = visible([hero.querySelector(".logo-link"), ...all(".nav button"), ...all(".masthead-actions > *")]);
    const description = hero.querySelector(".description");
    const buttons = all(".hero-actions > *");
    if (compact) buttons.reverse(); // on phones the dark button is on top
    const fill = hero.querySelector(".turnover-fill");
    const valueNode = hero.querySelector(".turnover-value");
    const planRing = hero.querySelector(".condition-ring");
    const target = Number(valueNode.textContent);
    const counter = { value: Math.round(target * 0.6) }; // starts from a plausible figure, not from zero
    const ringTarget = planRing.getAttribute("stroke-dasharray");

    const timeline = animator.timeline({ paused: true, onComplete: finish });

    // Phone: a separate layer that rises on the camera's slowdown (decision 53).
    // It starts just below the hero edge, so it travels no further than needed,
    // and lands on the last video frame (3.0 s). This timeline is not played:
    // it follows the displayed video frames, with two phone steps per frame.
    animator.set(phone, { autoAlpha: 1, clearProps: "transform" });
    const phoneBox = phone.getBoundingClientRect();
    // The backward tilt lifts the top edge in perspective, hence the extra 15 % of height.
    const travel = hero.getBoundingClientRect().bottom - phoneBox.top + phoneBox.height * 0.15;
    const landing = VIDEO_END - TIME.phone;
    phoneMotion = animator.timeline({ paused: true })
      // force3D keeps the phone on one GPU layer to the end: no re-render when it lands.
      .fromTo(phone, { y: travel }, { y: 0, duration: landing, ease: "power2.out", force3D: true }, TIME.phone)
      .fromTo(phone, { rotationX: 20 }, { rotationX: 0, duration: landing, ease: "power1.inOut", force3D: true }, TIME.phone);

    // Headline halves come from opposite sides and sharpen as they slow down.
    const lineIn = (lines, direction, at) => {
      timeline
        .fromTo(lines, { x: direction * shift }, { x: 0, duration: 1.8, ease: "expo.out", stagger: 0.1 }, at)
        .fromTo(lines,
          { autoAlpha: 0, filter: "blur(12px)" },
          { autoAlpha: 1, filter: "blur(0px)", duration: 1.1, ease: "power2.out", stagger: 0.1, clearProps: "filter" },
          at);
    };
    lineIn(leftLines, -1, TIME.titleLeft);
    lineIn(rightLines, 1, TIME.titleRight);

    // Header pill drops in, then its items follow left to right.
    timeline
      .fromTo(header, { y: -24, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 1.5, ease: "expo.out" }, TIME.header)
      .fromTo(headerItems, { y: -8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 1.2, ease: "expo.out", stagger: 0.045, clearProps: "transform,opacity,visibility" }, TIME.header + 0.12);

    // Inside the phone: progress bar, plan ring and the figure fill up.
    timeline
      .fromTo(fill, { clipPath: "inset(0% 45% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 1.6, ease: "power2.out" }, TIME.screen)
      .fromTo(planRing, { attr: { "stroke-dasharray": "35 100" } }, { attr: { "stroke-dasharray": ringTarget }, duration: 1.6, ease: "power2.out" }, TIME.screen + 0.1)
      .fromTo(counter, { value: counter.value }, {
        value: target,
        duration: 1.6,
        ease: "power2.out",
        onUpdate: () => { valueNode.textContent = Math.round(counter.value); }
      }, TIME.screen);

    // Text and buttons rise softly from below.
    timeline
      .fromTo(description,
        { y: 20, autoAlpha: 0, filter: "blur(6px)" },
        { y: 0, autoAlpha: 1, filter: "blur(0px)", duration: 1.4, ease: "expo.out", clearProps: "filter" },
        TIME.description)
      .fromTo(buttons,
        { y: 20, scale: 0.96, autoAlpha: 0 },
        { y: 0, scale: 1, autoAlpha: 1, duration: 1.3, ease: "expo.out", stagger: 0.09, clearProps: "transform,opacity,visibility" },
        TIME.actions);

    return timeline;
  }

  function finish() {
    stopUpdates();
    setControls(false);
    if (hero.dataset.intro !== "reduced") hero.dataset.intro = "ready";
  }

  function showFinal(state = "ready") {
    run += 1;
    stopUpdates();
    video.pause();
    video.classList.remove("is-visible");
    hero.dataset.intro = state;
    if (phoneMotion) setPhone(VIDEO_END);
    if (sequence) sequence.progress(1);
    else animator.set(hero.querySelector(".phone"), { autoAlpha: 1 });
    finish();
  }

  const frameCallbacks = "requestVideoFrameCallback" in video;
  function setPhone(time) {
    phoneMotion.time(time);
  }

  // Remember when each video frame was actually shown.
  function trackFrames(id) {
    if (!frameCallbacks) return;
    const onFrame = (now, meta) => {
      if (id !== run) return;
      lastFrame = { time: meta.mediaTime, at: now };
      if (!video.ended) video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  // Scene time for the phone: the last shown frame plus the steps allowed between frames.
  function phoneTime(now) {
    const frameLength = 1 / VIDEO_FPS;
    const step = frameLength / PHONE_STEPS;
    if (!frameCallbacks) return Math.round(video.currentTime / step) * step;
    const since = Math.max(0, (now - lastFrame.at) / 1000);
    return lastFrame.time + Math.min(Math.floor(since / step) * step, frameLength - step);
  }

  function followVideo(id) {
    frame = window.requestAnimationFrame((now) => {
      if (id !== run) return;
      if (!video.paused && !video.ended) {
        const drift = video.currentTime - sequence.time();
        if (Math.abs(drift) > MAX_DRIFT) sequence.time(video.currentTime);
        setPhone(phoneTime(now));
      }
      if (sequence.progress() < 1) followVideo(id);
    });
  }

  function begin(id, time) {
    if (id !== run || hero.dataset.intro !== "loading") return;
    window.clearTimeout(timer);
    hero.dataset.intro = "playing";
    lastFrame = { time, at: performance.now() };
    setPhone(time);
    sequence.play(time);
    trackFrames(id);
    followVideo(id);
  }

  function playWithoutVideo(id) {
    if (id !== run || hero.dataset.intro !== "loading") return;
    window.clearTimeout(timer);
    video.pause();
    video.classList.remove("is-visible");
    hero.dataset.intro = "fallback";
    // No video to match: the phone moves smoothly with the interface.
    const sync = () => setPhone(sequence.time());
    sequence.eventCallback("onUpdate", sync);
    sequence.play(FALLBACK_FROM);
  }

  function startIntro() {
    if (reducedMotion.matches) {
      showFinal("reduced");
      return;
    }

    const id = ++run;
    stopUpdates();
    video.pause();
    sequence = buildSequence();
    hero.dataset.intro = "loading";
    setControls(true);
    video.classList.add("is-visible");
    if (video.readyState > 0) video.currentTime = 0;

    timer = window.setTimeout(() => playWithoutVideo(id), START_TIMEOUT);
    Promise.resolve(video.play()).then(() => {
      if (id !== run) return;
      // Start the clock on the first frame actually shown, not on the play() call.
      if (frameCallbacks) {
        video.requestVideoFrameCallback((now, meta) => begin(id, meta.mediaTime));
      } else {
        begin(id, video.currentTime);
      }
    }).catch(() => playWithoutVideo(id));
  }

  // If the video stalls, the scene waits for it instead of running ahead.
  video.addEventListener("waiting", () => {
    if (hero.dataset.intro === "playing" && !video.ended) sequence.pause();
  });
  video.addEventListener("playing", () => {
    if (hero.dataset.intro === "playing" && sequence.paused()) sequence.play(video.currentTime);
  });
  video.addEventListener("ended", () => {
    if (hero.dataset.intro === "playing") setPhone(VIDEO_END);
  });
  video.addEventListener("error", () => playWithoutVideo(run));
  // With <source> children the error fires on the last <source>, not on the <video>.
  video.querySelector("source:last-of-type")?.addEventListener("error", () => playWithoutVideo(run));

  reducedMotion.addEventListener("change", () => showFinal(reducedMotion.matches ? "reduced" : "ready"));

  startIntro();
})();
