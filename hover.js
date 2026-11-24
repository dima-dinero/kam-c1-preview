/*
 * Hover language of the site, one idea: glass reacts to the pointer.
 *  - Nav: a glass pill follows the pointer or keyboard focus between items.
 *  - Buttons: a soft light follows the pointer across the button (CSS reads
 *    --mx / --my); on press the button gives way.
 * Only for devices with a real hover; nothing here runs per frame on its own.
 */
(() => {
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");

  // ---------- Nav: flowing glass pill ----------
  const nav = document.querySelector(".nav");
  if (nav) {
    const pill = document.createElement("span");
    pill.className = "nav-pill";
    pill.setAttribute("aria-hidden", "true");
    nav.prepend(pill);
    const links = [...nav.querySelectorAll("button")];
    const PAD = 14; // px of pill around the text

    const moveTo = (link) => {
      const first = !nav.classList.contains("has-pill");
      if (first) nav.classList.add("pill-jump"); // appear in place, do not fly in from the last spot
      pill.style.setProperty("--x", link.offsetLeft - PAD + "px");
      pill.style.setProperty("--w", link.offsetWidth + PAD * 2 + "px");
      nav.classList.add("has-pill");
      if (first) requestAnimationFrame(() => requestAnimationFrame(() => nav.classList.remove("pill-jump")));
    };
    const hide = () => nav.classList.remove("has-pill");

    for (const link of links) {
      link.addEventListener("pointerenter", () => canHover.matches && moveTo(link));
      link.addEventListener("focus", () => link.matches(":focus-visible") && moveTo(link));
      link.addEventListener("blur", () => !nav.matches(":hover") && hide());
    }
    nav.addEventListener("pointerleave", hide);
  }

  // ---------- Buttons: light under the pointer ----------
  for (const button of document.querySelectorAll(".pill")) {
    button.addEventListener("pointermove", (event) => {
      if (!canHover.matches) return;
      const box = button.getBoundingClientRect();
      button.style.setProperty("--mx", event.clientX - box.left + "px");
      button.style.setProperty("--my", event.clientY - box.top + "px");
    });
  }
})();
