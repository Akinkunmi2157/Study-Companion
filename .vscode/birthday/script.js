/* ============================================================================
   ============================  EASY CONFIGURATION  ==========================
   Edit everything in this block to personalize the site. Nothing below
   the "END CONFIGURATION" marker needs to change for basic customization.
   ============================================================================ */
const CONFIG = {
  // ---- Person -------------------------------------------------------------
  NAME: "Oluwatomiloye",
  NAME_SHORT: "Tomiloye",
  AGE: 25,                       // shown on the "Happy Birthday" screen

  // ---- Birthday date (used for the live countdown gate) -------------------
  // Month is 1-12. If today is on/after this date, the countdown gate is
  // skipped automatically and the site opens straight to the locked screen.
  BIRTHDAY_MONTH: 8,
  BIRTHDAY_DAY: 10,

  // ---- Security -------------------------------------------------------------
  PIN: "0912",

  // ---- Media ----------------------------------------------------------------
  AVATAR_IMAGE: "assets/images/couple-main.jpg",
  MUSIC_FILE: "assets/audio/bg-music.mp3", // add your own mp3 at this path

  // ---- The Letter -----------------------------------------------------------
  LETTER_SALUTATION_NAME: "Love",
  LETTER_MESSAGE:
    "You are the most beautiful part of my life, and I'm so lucky to have you. " +
    "Your smile makes my days better, and your presence makes everything feel special. " +
    "I hope your birthday is filled with happiness, love, and endless smiles.\n\n" +
    "Always stay happy — because your happiness means a lot to me. 💗",

  // ---- Memories timeline (photo OR video, date + short description) --------
  MEMORIES: [
    {
      type: "image",
      src: "assets/images/couple-main.jpg",
      date: "Us · 2024",
      desc: "The two of us, right at home.",
    },
    {
      type: "image",
      src: "assets/images/solo-white-tee.jpg",
      date: "Milestone Day",
      desc: "God, mum and dad, family, friends — thank you all.",
      secret: "You don't just light up a room — you're the reason I smile before I even know why.",
    },
    {
      type: "image",
      src: "assets/images/solo-lace-dress.jpg",
      date: "Dressed Up",
      desc: "Elegant, effortless, unforgettable.",
    },
    {
      type: "video",
      src: "assets/video/memory-clip-1.mp4",
      poster: "assets/video/memory-clip-1-poster.jpg",
      date: "Silly Moments",
      desc: "The clips that always make us laugh.",
    },
    {
      type: "image",
      src: "assets/images/solo-blue-top.jpg",
      date: "Just Because",
      desc: "No occasion needed — you always shine.",
    },
    {
      type: "image",
      src: "assets/images/solo-framing.jpg",
      date: "Picture Perfect",
      desc: "Framing the moments worth keeping.",
      secret: "Every memory with you is one I'd choose to relive, over and over again.",
    },
    {
      type: "video",
      src: "assets/video/memory-clip-2.mp4",
      poster: "assets/video/memory-clip-2-poster.jpg",
      date: "Dancing It Out",
      desc: "Your energy is unmatched.",
    },
    {
      type: "image",
      src: "assets/images/event-yellow-front.jpg",
      date: "Big Day",
      desc: "Proud doesn't even begin to cover it.",
    },
    {
      type: "image",
      src: "assets/images/event-yellow-side.jpg",
      date: "Behind the Scenes",
      desc: "The quiet moment before the applause.",
    },
    {
      type: "image",
      src: "assets/images/group-ambassadors.jpg",
      date: "Faith & Friends",
      desc: "Surrounded by the people — and purpose — that matter.",
    },
  ],

  // ---- Gift reveal ------------------------------------------------------------
  GIFT_MESSAGE:
    "Inside this little box is everything words can barely hold: " +
    "gratitude for you, pride in who you are, and excitement for everything " +
    "still ahead of you. Happy Birthday, " + "Oluwatomiloye" + ". 🎁💗",

  // ---- Personal video reveal ---------------------------------------------------
  VIDEO_TEASER: "There's one more thing I want you to see...",

  // ---- Cinematic finale ---------------------------------------------------------
  FINALE_PRELINE: "Always & forever",
  FINALE_MESSAGE:
    "Happy Birthday, Oluwatomiloye. Here's to twenty-five and every beautiful year still coming. 💗",

  // ---- Easter egg (tap the watermark text 5 times to find it) -------------------
  EASTER_EGG_MESSAGE:
    "This whole thing was built one late night, one memory, one line of code at a time — because you're worth every bit of it.",
};
/* ==========================  END CONFIGURATION  =========================== */


/* ============================================================================
   STATE
   ============================================================================ */
const state = {
  pinEntered: "",
  musicStarted: false,
  chaptersDone: { memories: false, letter: false, gift: false },
  letterOpened: false,
  letterTyped: false,
  giftOpened: false,
  galleryIndex: 0,
  eggTaps: 0,
  countdownDone: false,
};

/* ============================================================================
   UTILITIES
   ============================================================================ */
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function goToScreen(id) {
  $all(".screen").forEach(s => s.classList.remove("active"));
  const target = document.getElementById(id);
  if (target) {
    target.classList.add("active");
    target.scrollTop = 0;
  }
}

function vibrateIfSupported(ms) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { } }
}

/* ============================================================================
   BACKGROUND MUSIC
   ============================================================================ */
const audioEl = $("#bg-audio");
const musicToggle = $("#music-toggle");

function unlockMusic() {
  if (state.musicStarted) return;
  state.musicStarted = true;
  musicToggle.hidden = false;
  audioEl.volume = 0;
  const playPromise = audioEl.play();
  if (playPromise && playPromise.then) {
    playPromise.then(fadeMusicIn).catch(() => {
      // Autoplay blocked or file missing — keep the control visible but paused.
      musicToggle.classList.add("is-paused");
      showPlayIcon();
    });
  } else {
    fadeMusicIn();
  }
}

function fadeMusicIn() {
  let vol = 0;
  const step = setInterval(() => {
    vol += 0.05;
    if (vol >= 0.5) { vol = 0.5; clearInterval(step); }
    audioEl.volume = vol;
  }, 80);
  showPauseIcon();
}

function showPauseIcon() {
  musicToggle.querySelector(".icon-play")?.setAttribute("hidden", "");
  musicToggle.querySelector(".icon-pause")?.removeAttribute("hidden");
  musicToggle.classList.remove("is-paused");
}
function showPlayIcon() {
  musicToggle.querySelector(".icon-play")?.removeAttribute("hidden");
  musicToggle.querySelector(".icon-pause")?.setAttribute("hidden", "");
  musicToggle.classList.add("is-paused");
}

musicToggle.addEventListener("click", () => {
  if (audioEl.paused) {
    audioEl.play().then(fadeMusicIn).catch(() => { });
  } else {
    audioEl.pause();
    showPlayIcon();
  }
});

/* ============================================================================
   BIRTHDAY COUNTDOWN GATE
   ============================================================================ */
function getNextBirthday() {
  const now = new Date();
  let year = now.getFullYear();
  let target = new Date(year, CONFIG.BIRTHDAY_MONTH - 1, CONFIG.BIRTHDAY_DAY, 0, 0, 0);
  if (target < now) {
    target = new Date(year + 1, CONFIG.BIRTHDAY_MONTH - 1, CONFIG.BIRTHDAY_DAY, 0, 0, 0);
  }
  return target;
}

let countdownTimer = null;
function initCountdownGate() {
  const now = new Date();
  const todayIsBirthday =
    now.getMonth() === CONFIG.BIRTHDAY_MONTH - 1 && now.getDate() === CONFIG.BIRTHDAY_DAY;

  if (todayIsBirthday) {
    state.countdownDone = true;
    goToScreen("screen-locked");
    return;
  }

  goToScreen("screen-countdown");
  const target = getNextBirthday();
  tickCountdown(target);
  countdownTimer = setInterval(() => tickCountdown(target), 1000);
}

function tickCountdown(target) {
  const now = new Date();
  let diff = target - now;
  if (diff <= 0) {
    clearInterval(countdownTimer);
    state.countdownDone = true;
    triggerCountdownCelebration();
    return;
  }
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  $("#cd-days").textContent = String(d).padStart(2, "0");
  $("#cd-hours").textContent = String(h).padStart(2, "0");
  $("#cd-mins").textContent = String(m).padStart(2, "0");
  $("#cd-secs").textContent = String(s).padStart(2, "0");
}

function triggerCountdownCelebration() {
  launchConfetti(1800);
  setTimeout(() => goToScreen("screen-locked"), 1200);
}

/* ============================================================================
   LOCK SCREEN / PIN
   ============================================================================ */
const pinDots = $all(".pin-dot");
const pinError = $("#pin-error");
const lockCard = $(".lock-card");

function renderPin() {
  pinDots.forEach((dot, i) => {
    const char = state.pinEntered[i];
    dot.classList.toggle("filled", !!char);
    dot.textContent = char || "";
  });
}

function handleKey(key) {
  pinError.classList.remove("show");
  if (key === "back") {
    state.pinEntered = state.pinEntered.slice(0, -1);
    renderPin();
    return;
  }
  if (key === "clear") {
    state.pinEntered = "";
    renderPin();
    return;
  }
  if (state.pinEntered.length >= 4) return;
  state.pinEntered += key;
  renderPin();
  vibrateIfSupported(8);

  if (state.pinEntered.length === 4) {
    setTimeout(checkPin, 220);
  }
}

function checkPin() {
  if (state.pinEntered === CONFIG.PIN) {
    unlockMusic();
    goToScreen("screen-loading");
    runLoadingSequence();
  } else {
    pinError.classList.add("show");
    lockCard.classList.add("shake");
    vibrateIfSupported([40, 40, 40]);
    setTimeout(() => {
      lockCard.classList.remove("shake");
      state.pinEntered = "";
      renderPin();
    }, 420);
  }
}

$("#keypad").addEventListener("click", (e) => {
  const btn = e.target.closest(".key");
  if (!btn) return;
  handleKey(btn.dataset.key);
});

document.addEventListener("keydown", (e) => {
  if (!$("#screen-locked").classList.contains("active")) return;
  if (e.key >= "0" && e.key <= "9") handleKey(e.key);
  else if (e.key === "Backspace") handleKey("back");
  else if (e.key === "Escape") handleKey("clear");
});

// Passkey reveal overlay
const passkeyOverlay = $("#passkey-overlay");
$("#lock-avatar").addEventListener("click", () => {
  passkeyOverlay.classList.add("show");
});
$("#passkey-close").addEventListener("click", () => passkeyOverlay.classList.remove("show"));
passkeyOverlay.addEventListener("click", (e) => {
  if (e.target === passkeyOverlay) passkeyOverlay.classList.remove("show");
});

/* ============================================================================
   LOADING SEQUENCE
   ============================================================================ */
function runLoadingSequence() {
  const fill = $("#loading-fill");
  fill.style.width = "0%";
  requestAnimationFrame(() => { fill.style.width = "100%"; });
  setTimeout(() => goToScreen("screen-start"), 2200);
}

$("#btn-start").addEventListener("click", () => {
  goToScreen("screen-birthday");
});

/* ============================================================================
   BIRTHDAY / AGE SCREEN
   ============================================================================ */
$("#age-years").textContent = CONFIG.AGE;
$("#birthday-heading").innerHTML = `Happy Birthday ${CONFIG.NAME_SHORT} <span class="emoji">🎀</span>`;

$("#btn-to-hub").addEventListener("click", () => {
  goToScreen("screen-hub");
});

/* ============================================================================
   HUB / CHOOSE YOUR PATH / CHAPTER TRACKER
   ============================================================================ */
function updateChapterTracker() {
  $all(".chapter-pip").forEach(pip => {
    const key = pip.dataset.chapter;
    pip.classList.toggle("done", !!state.chaptersDone[key]);
  });
  $all(".path-card[data-chapter]").forEach(card => {
    const key = card.dataset.chapter;
    card.classList.toggle("visited", !!state.chaptersDone[key]);
  });
  const allDone = Object.values(state.chaptersDone).every(Boolean);
  $("#btn-to-finale").hidden = !allDone;
}

$all(".path-card").forEach(card => {
  card.addEventListener("click", () => {
    const target = card.dataset.target;
    goToScreen(target);
    if (target === "screen-memories") initMemoriesView();
  });
});

$("#btn-to-finale").addEventListener("click", () => {
  goToScreen("screen-video");
});

/* ============================================================================
   MEMORIES TIMELINE
   ============================================================================ */
let memoriesBuilt = false;
function buildTimeline() {
  const wrap = $("#timeline");
  wrap.innerHTML = "";
  CONFIG.MEMORIES.forEach((mem, i) => {
    const card = document.createElement("div");
    card.className = "memory-card";
    card.style.transitionDelay = (i * 0.05) + "s";

    let mediaHTML;
    if (mem.type === "video") {
      mediaHTML = `<video class="memory-card__media" src="${mem.src}" poster="${mem.poster || ""}" muted loop playsinline preload="metadata"></video><span class="memory-card__play">▶</span>`;
    } else {
      mediaHTML = `<img class="memory-card__media" src="${mem.src}" alt="${mem.desc}" loading="lazy">`;
    }

    const secretHTML = mem.secret ? `<button class="memory-card__secret" aria-label="secret" data-secret="${i}">✨</button>` : "";

    card.innerHTML = `
      ${mediaHTML}
      ${secretHTML}
      <div class="memory-card__body">
        <p class="memory-card__date">${mem.date}</p>
        <p class="memory-card__desc">${mem.desc}</p>
      </div>
    `;
    wrap.appendChild(card);

    if (mem.type === "video") {
      const vid = card.querySelector("video");
      card.addEventListener("click", (e) => {
        if (e.target.closest(".memory-card__secret")) return;
        if (vid.paused) { vid.play(); } else { vid.pause(); }
      });
    }
  });

  // secret message buttons
  $all(".memory-card__secret").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.secret);
      const mem = CONFIG.MEMORIES[idx];
      if (mem && mem.secret) revealSecret(mem.secret);
    });
  });

  observeMemoryCards();
}

function observeMemoryCards() {
  const cards = $all(".memory-card");
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("in-view");
      }
    });
  }, { threshold: 0.25, root: $("#timeline") });
  cards.forEach(c => io.observe(c));
}

function initMemoriesView() {
  if (!memoriesBuilt) {
    buildTimeline();
    memoriesBuilt = true;
  } else {
    // re-trigger the reveal animation each visit
    $all(".memory-card").forEach(c => c.classList.remove("in-view"));
    requestAnimationFrame(observeMemoryCards);
  }
}

$("#btn-memories-done").addEventListener("click", () => {
  state.chaptersDone.memories = true;
  updateChapterTracker();
  goToScreen("screen-hub");
});

$("#btn-open-gallery").addEventListener("click", () => {
  openGallery(0);
});

/* ============================================================================
   FULLSCREEN GALLERY
   ============================================================================ */
const galleryImages = CONFIG.MEMORIES.filter(m => m.type === "image");
let galleryBuilt = false;

function buildGallery() {
  const vp = $("#gallery-viewport");
  const dots = $("#gallery-dots");
  vp.innerHTML = "";
  dots.innerHTML = "";
  galleryImages.forEach((mem, i) => {
    const slide = document.createElement("div");
    slide.className = "gallery__slide";
    slide.dataset.index = i;
    slide.innerHTML = `<img src="${mem.src}" alt="${mem.desc}">`;
    vp.appendChild(slide);

    const dot = document.createElement("span");
    dot.className = "gd";
    dots.appendChild(dot);
  });
  galleryBuilt = true;
}

function renderGallery() {
  $all(".gallery__slide").forEach((slide, i) => {
    slide.classList.toggle("active", i === state.galleryIndex);
  });
  $all(".gallery__dots .gd").forEach((dot, i) => {
    dot.classList.toggle("active", i === state.galleryIndex);
  });
  $("#gallery-caption").textContent = galleryImages[state.galleryIndex]?.desc || "";
}

function openGallery(startIndex) {
  if (!galleryBuilt) buildGallery();
  state.galleryIndex = startIndex || 0;
  renderGallery();
  goToScreen("screen-gallery");
}

function galleryStep(dir) {
  state.galleryIndex = (state.galleryIndex + dir + galleryImages.length) % galleryImages.length;
  renderGallery();
}

$("#gallery-prev").addEventListener("click", () => galleryStep(-1));
$("#gallery-next").addEventListener("click", () => galleryStep(1));
$("#gallery-close").addEventListener("click", () => goToScreen("screen-memories"));

document.addEventListener("keydown", (e) => {
  if (!$("#screen-gallery").classList.contains("active")) return;
  if (e.key === "ArrowLeft") galleryStep(-1);
  if (e.key === "ArrowRight") galleryStep(1);
  if (e.key === "Escape") goToScreen("screen-memories");
});

// touch swipe support
(function initGallerySwipe() {
  const vp = $("#gallery-viewport");
  let startX = 0, startY = 0, tracking = false;
  vp.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  vp.addEventListener("touchend", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      galleryStep(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
})();

/* ============================================================================
   LETTER
   ============================================================================ */
const letterModal = $("#letter-modal");
const envelopeBtn = $("#envelope-btn");
const envelopeLabel = $("#envelope-label");

$("#letter-name").textContent = CONFIG.LETTER_SALUTATION_NAME;

envelopeBtn.addEventListener("click", () => {
  if (state.letterOpened) {
    letterModal.classList.add("show");
    return;
  }
  state.letterOpened = true;
  envelopeBtn.classList.add("opening");
  envelopeLabel.textContent = "Opening Letter...";
  vibrateIfSupported(10);

  setTimeout(() => {
    letterModal.classList.add("show");
    if (!state.letterTyped) typeLetter();
  }, 900);
});

function typeLetter() {
  state.letterTyped = true;
  const el = $("#letter-text");
  const text = CONFIG.LETTER_MESSAGE;
  el.textContent = "";
  const cursor = document.createElement("span");
  cursor.className = "cursor";
  cursor.textContent = "|";

  let i = 0;
  const speed = 22;
  function step() {
    if (i <= text.length) {
      el.textContent = text.slice(0, i);
      el.appendChild(cursor);
      i++;
      setTimeout(step, speed);
    } else {
      cursor.remove();
    }
  }
  step();
}

$("#letter-close").addEventListener("click", () => letterModal.classList.remove("show"));
letterModal.addEventListener("click", (e) => {
  if (e.target === letterModal) letterModal.classList.remove("show");
});

$("#btn-restart-letter").addEventListener("click", () => {
  letterModal.classList.remove("show");
});

$("#btn-celebrate").addEventListener("click", () => {
  launchConfetti(2200);
  state.chaptersDone.letter = true;
  updateChapterTracker();
  vibrateIfSupported(15);
});

$("#secret-heart-letter").addEventListener("click", (e) => {
  e.stopPropagation();
  revealSecret("Every word in this letter is true, today and every day after.");
});

/* ============================================================================
   GIFT
   ============================================================================ */
const giftBox = $("#gift-box");
const giftReveal = $("#gift-reveal");

giftBox.addEventListener("click", () => {
  if (state.giftOpened) {
    giftBox.classList.add("shake");
    setTimeout(() => giftBox.classList.remove("shake"), 500);
    return;
  }
  state.giftOpened = true;
  giftBox.classList.add("shake");
  vibrateIfSupported(12);

  setTimeout(() => {
    giftBox.classList.remove("shake");
    giftBox.classList.add("opened");
    launchConfetti(1600);
    $("#gift-reveal-text").textContent = CONFIG.GIFT_MESSAGE;
    giftReveal.classList.add("show");
    state.chaptersDone.gift = true;
    updateChapterTracker();
  }, 500);
});

$("#btn-gift-continue").addEventListener("click", () => {
  goToScreen("screen-hub");
});

/* ============================================================================
   PERSONAL VIDEO REVEAL
   ============================================================================ */
$("#video-teaser").textContent = CONFIG.VIDEO_TEASER;

$("#btn-reveal-video").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  btn.hidden = true;
  $("#video-frame").hidden = false;
  $("#btn-to-final").hidden = false;
  const vid = $("#reveal-video");
  vid.play().catch(() => { });
});

$("#btn-to-final").addEventListener("click", () => {
  goToScreen("screen-finale");
  runFinale();
});

/* ============================================================================
   CINEMATIC FINALE
   ============================================================================ */
function runFinale() {
  $("#finale-preline").textContent = CONFIG.FINALE_PRELINE;
  $("#finale-name").textContent = CONFIG.NAME;
  $("#finale-message").textContent = CONFIG.FINALE_MESSAGE;
  setTimeout(() => launchConfetti(2600, true), 1400);
}

$("#btn-finale-restart").addEventListener("click", () => {
  location.reload();
});

/* ============================================================================
   SECRET MESSAGE TOAST
   ============================================================================ */
let secretTimer = null;
function revealSecret(message) {
  const toast = $("#secret-toast");
  $("#secret-toast-text").textContent = message;
  toast.classList.add("show");
  vibrateIfSupported([10, 30, 10]);
  clearTimeout(secretTimer);
  secretTimer = setTimeout(() => toast.classList.remove("show"), 4200);
}

/* ============================================================================
   EASTER EGG
   ============================================================================ */
const eggModal = $("#egg-modal");
$("#easter-watermark").addEventListener("click", () => {
  state.eggTaps++;
  if (state.eggTaps >= 5) {
    state.eggTaps = 0;
    $("#egg-text").textContent = CONFIG.EASTER_EGG_MESSAGE;
    eggModal.classList.add("show");
    launchConfetti(900);
  }
});
$("#egg-close").addEventListener("click", () => eggModal.classList.remove("show"));
eggModal.addEventListener("click", (e) => { if (e.target === eggModal) eggModal.classList.remove("show"); });

/* ============================================================================
   CONFETTI
   ============================================================================ */
const confettiCanvas = $("#confetti-canvas");
const cctx = confettiCanvas.getContext("2d");
let confettiParticles = [];
let confettiRAF = null;

function resizeCanvases() {
  [confettiCanvas, $("#particle-canvas")].forEach(c => {
    c.width = window.innerWidth * devicePixelRatio;
    c.height = window.innerHeight * devicePixelRatio;
    c.style.width = window.innerWidth + "px";
    c.style.height = window.innerHeight + "px";
  });
}
window.addEventListener("resize", resizeCanvases);
resizeCanvases();

const CONFETTI_COLORS = ["#ff2d6b", "#f4c6cf", "#ffffff", "#e8a0ad", "#7a1a24"];

function launchConfetti(duration = 2000, dense = false) {
  const count = dense ? 140 : 90;
  const w = confettiCanvas.width, h = confettiCanvas.height;
  for (let i = 0; i < count; i++) {
    confettiParticles.push({
      x: Math.random() * w,
      y: -20 * devicePixelRatio,
      vx: (Math.random() - 0.5) * 2.4 * devicePixelRatio,
      vy: (2 + Math.random() * 3) * devicePixelRatio,
      size: (4 + Math.random() * 6) * devicePixelRatio,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.2,
      shape: Math.random() > 0.5 ? "circle" : "petal",
      life: 0,
      maxLife: duration + Math.random() * 800,
    });
  }
  if (!confettiRAF) confettiRAF = requestAnimationFrame(tickConfetti);
}

function tickConfetti() {
  cctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  confettiParticles.forEach(p => {
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    p.life += 16;
    cctx.save();
    cctx.translate(p.x, p.y);
    cctx.rotate(p.rot);
    cctx.globalAlpha = Math.max(0, 1 - p.life / p.maxLife);
    cctx.fillStyle = p.color;
    if (p.shape === "circle") {
      cctx.beginPath();
      cctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
      cctx.fill();
    } else {
      cctx.beginPath();
      cctx.ellipse(0, 0, p.size / 2, p.size, 0, 0, Math.PI * 2);
      cctx.fill();
    }
    cctx.restore();
  });
  confettiParticles = confettiParticles.filter(p => p.life < p.maxLife && p.y < confettiCanvas.height + 40);
  if (confettiParticles.length > 0) {
    confettiRAF = requestAnimationFrame(tickConfetti);
  } else {
    confettiRAF = null;
  }
}

/* ============================================================================
   AMBIENT PARTICLES (subtle floating hearts / sparkles)
   ============================================================================ */
const pctx = $("#particle-canvas").getContext("2d");
const ambientParticles = [];
const AMBIENT_COUNT = 22;

function initAmbientParticles() {
  const w = window.innerWidth * devicePixelRatio;
  const h = window.innerHeight * devicePixelRatio;
  for (let i = 0; i < AMBIENT_COUNT; i++) {
    ambientParticles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: (0.6 + Math.random() * 1.6) * devicePixelRatio,
      vy: (0.12 + Math.random() * 0.22) * devicePixelRatio,
      drift: Math.random() * Math.PI * 2,
      alpha: 0.15 + Math.random() * 0.3,
    });
  }
  requestAnimationFrame(tickAmbient);
}

function tickAmbient() {
  const canvas = $("#particle-canvas");
  pctx.clearRect(0, 0, canvas.width, canvas.height);
  ambientParticles.forEach(p => {
    p.y -= p.vy;
    p.drift += 0.01;
    p.x += Math.sin(p.drift) * 0.3;
    if (p.y < -10) { p.y = canvas.height + 10; p.x = Math.random() * canvas.width; }
    pctx.beginPath();
    pctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    pctx.fillStyle = `rgba(244,198,207,${p.alpha})`;
    pctx.fill();
  });
  requestAnimationFrame(tickAmbient);
}
initAmbientParticles();

/* ============================================================================
   INIT
   ============================================================================ */
document.title = `Happy Birthday, ${CONFIG.NAME} 🎀`;
initCountdownGate();
