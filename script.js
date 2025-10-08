



// small safe HTML escaper
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

let currentSong = new Audio();
let playButton, prevButton, nextButton;
let songs = [];
let currentFolder;
let _fadeTimer = null;
let _fadeRaf = null;

// track last user-set volume so fade-in can restore to it reliably
let lastUserVolume = 1;

// Paths used in repo: /songs and svg/
// Adjust BASE_SONGS_PATH when deploying (you said you want /Spotify/songs for localhost)
const BASE_SONGS_PATH = `/songs`;
const ICON_PATH = "svg"; // folder where svgs live

const DEFAULT_IMAGE = ICON_PATH + "/music.svg";
const IMAGE_EXT_CANDIDATES = [".jpeg", ".jpg", ".png"];

// ensure audio preloads and is allowed on mobile (best-effort)
currentSong.preload = "metadata";
currentSong.crossOrigin = "anonymous";

// build candidate image URLs for an mp3 filename inside a folder
function buildImageCandidatesFor(mp3Filename, folder) {
  const base = mp3Filename.replace(/\.mp3$/i, "").replaceAll("%20", " ").trim();
  const encodedFolder = encodeURIComponent(folder);
  return IMAGE_EXT_CANDIDATES.map(
    (ext) => `${BASE_SONGS_PATH}/${encodedFolder}/${encodeURIComponent(base + ext)}`
  );
}

// set img src with fallback candidates. If none available use finalFallback.
function setImgSrcWithFallback(imgEl, srcCandidates = [], finalFallback = DEFAULT_IMAGE) {
  if (!imgEl) return;
  let i = 0;
  imgEl.onerror = null;
  function tryNext() {
    if (i >= srcCandidates.length) {
      imgEl.onerror = null;
      imgEl.src = finalFallback;
      return;
    }
    const candidate = srcCandidates[i++];
    imgEl.onerror = tryNext;
    imgEl.src = candidate;
  }
  tryNext();
}

function secondsToMinutesSeconds(seconds) {
  if (isNaN(seconds) || seconds < 0) return "00:00";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  const formattedMinutes = String(minutes).padStart(2, "0");
  const formattedSeconds = String(remainingSeconds).padStart(2, "0");
  return `${formattedMinutes}:${formattedSeconds}`;
}

/* marquee helper (keeps long text sliding) */
function enableMarquee(container) {
  if (!container || !(container instanceof HTMLElement)) return;

  // ensure we have an inner wrapper
  let inner = container.querySelector(".marquee-inner");
  if (!inner) {
    inner = document.createElement("span");
    inner.className = "marquee-inner";
    while (container.firstChild) inner.appendChild(container.firstChild);
    container.appendChild(inner);
  }

  if (container._marqueeAnim) {
    try { container._marqueeAnim.cancel(); } catch(e) {}
    container._marqueeAnim = null;
  }
  inner.style.transform = "translateX(0)";

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const innerWidth = inner.scrollWidth;
      const containerWidth = container.clientWidth;
      if (innerWidth > containerWidth + 4) {
        const shift = -(innerWidth - containerWidth);
        const durationSec = Math.max(4, Math.min(20, Math.abs(shift) / 25));
        const duration = durationSec * 1000;
        const anim = inner.animate(
          [{ transform: "translateX(0)" }, { transform: `translateX(${shift}px)` }],
          { duration, iterations: Infinity, direction: "alternate", easing: "linear" }
        );
        container._marqueeAnim = anim;
      } else {
        try { inner.style.transform = "translateX(0)"; } catch(e){}
      }
    });
  });
}

function setInitialTimer() {
  const timerEl = document.querySelector(".songTime .timer");
  if (timerEl) timerEl.textContent = "00:00 | 00:00";
}

// ---- directory scraping getSongs (works with directory index listing) ----
async function getSongs(folder) {
  currentFolder = folder;
  const listUrl = `${BASE_SONGS_PATH}/${encodeURIComponent(folder)}/index.json`;
  const a = await fetch(listUrl);
  const response = await a.text();

  const div = document.createElement("div");
  div.innerHTML = response;
  const as = div.getElementsByTagName("a");
  const out = [];
  for (let i = 0; i < as.length; i++) {
    const el = as[i];
    if (!el.href) continue;
    try {
      const url = new URL(el.href, window.location.href);
      const parts = url.pathname.split("/").filter(Boolean);
      const last = parts[parts.length - 1] || "";
      if (last.toLowerCase().endsWith(".mp3"))
        out.push(decodeURIComponent(last));
    } catch (err) {
      const seg = el.href.split("/").pop();
      if (seg && seg.toLowerCase().endsWith(".mp3"))
        out.push(decodeURIComponent(seg));
    }
  }
  return out;
}

// ---- robust fadeVolume (works with rAF and falls back to setInterval on mobile) ----
const fadeVolume = (to, duration = 2000, cb) => {
  // clear previous
  if (_fadeRaf) {
    cancelAnimationFrame(_fadeRaf);
    _fadeRaf = null;
  }
  if (_fadeTimer) {
    clearInterval(_fadeTimer);
    _fadeTimer = null;
  }

  const start = performance.now();
  const from = isFinite(currentSong.volume) ? currentSong.volume : (lastUserVolume || 1);
  const delta = to - from;

  if (duration <= 0) {
    currentSong.volume = Math.max(0, Math.min(1, to));
    if (cb) cb();
    return;
  }

  // try RAF-based smooth fade (preferred)
  let usingRAF = true;
  const stepRAF = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const v = from + delta * t;
    currentSong.volume = Math.max(0, Math.min(1, v));
    if (t < 1) {
      _fadeRaf = requestAnimationFrame(stepRAF);
    } else {
      _fadeRaf = null;
      if (cb) cb();
    }
  };

  // Start RAF; if RAF never runs within a short period (e.g. background tab / some mobile), fallback to interval
  _fadeRaf = requestAnimationFrame(stepRAF);

  // fallback timer after 220ms if RAF didn't progress (mobile browsers sometimes throttle RAF)
  const fallbackTimeout = setTimeout(() => {
    if (_fadeRaf) {
      // assume RAF is OK — let it continue
      clearTimeout(fallbackTimeout);
      return;
    }
    // else fallback to interval
    usingRAF = false;
    if (_fadeRaf) { cancelAnimationFrame(_fadeRaf); _fadeRaf = null; }
    const start2 = performance.now();
    const stepMs = 50;
    _fadeTimer = setInterval(() => {
      const now2 = performance.now();
      const t2 = Math.min(1, (now2 - start2) / duration);
      const v2 = from + delta * t2;
      currentSong.volume = Math.max(0, Math.min(1, v2));
      if (t2 >= 1) {
        clearInterval(_fadeTimer);
        _fadeTimer = null;
        if (cb) cb();
      }
    }, stepMs);
  }, 220);
};

// helpers for UI highlight management
function clearSongHighlights() {
  document.querySelectorAll(".songList ul li.playing").forEach(li => li.classList.remove("playing"));
  document.querySelectorAll(".songList ul li .padPlayBtn").forEach(btn => {
    if (btn && btn.tagName && btn.tagName.toLowerCase() === "img") btn.src = `${ICON_PATH}/play.svg`;
  });
}
function clearCardHighlights() {
  document.querySelectorAll(".card.playing-card").forEach(c => c.classList.remove("playing-card"));
}
function findLiByFilename(filename) {
  if (!filename) return null;
  return document.querySelector(`.songList ul li[data-file="${CSS.escape(filename)}"]`);
}
function getPadPlayImg(li) {
  if (!li) return null;
  return li.querySelector(".padPlayBtn");
}
function highlightCardForFolder(folder) {
  clearCardHighlights();
  if (!folder) return;
  const card = document.querySelector(`.card[data-folder="${CSS.escape(folder)}"]`);
  if (card) card.classList.add("playing-card");
}

const playMusic = (track, pause = false, fadeMs = 1000) => {
  if (!currentFolder) {
    console.warn("playMusic: currentFolder is not set. Call getSongs(folder) first.");
    return;
  }

  if (!/\.mp3$/i.test(track)) track = track + ".mp3";

  const url = `${BASE_SONGS_PATH}/${encodeURIComponent(currentFolder)}/` + encodeURIComponent(track);

  // choose desired volume: prefer lastUserVolume if currentSong.volume is 0 or not finite
  const desiredVolume = (typeof currentSong.volume === "number" && currentSong.volume > 0) ? currentSong.volume : (lastUserVolume || 1);

  fadeVolume(0, fadeMs, () => {
    try { currentSong.pause(); } catch (e) {}
    currentSong.src = url;
    currentSong.volume = 0;

    // update playbar info (image + title/artist)
    const infoEl = document.querySelector(".songInfo");
    if (infoEl) {
      const base = track.replace(/\.mp3$/i, "").replaceAll("%20", " ").trim();
      let artist = "";
      let title = base;
      const parts = base.split(" - ");
      if (parts.length >= 2) {
        artist = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
      }

      // recreate info area keeping the <img> if exists
      let imgEl = infoEl.querySelector("img");
      if (imgEl) {
        imgEl = imgEl.cloneNode(false);
        infoEl.innerHTML = "";
        infoEl.appendChild(imgEl);
      } else {
        infoEl.innerHTML = "";
        imgEl = document.createElement("img");
        imgEl.height = 35;
        imgEl.width = 35;
        imgEl.alt = "Song Poster";
        infoEl.appendChild(imgEl);
      }

      const meta = document.createElement("div");
      meta.className = "song-meta";
      const titleDiv = document.createElement("div");
      titleDiv.className = "title";
      titleDiv.textContent = title;
      const artistDiv = document.createElement("div");
      artistDiv.className = "artist";
      artistDiv.textContent = artist;
      meta.appendChild(titleDiv);
      meta.appendChild(artistDiv);
      infoEl.appendChild(meta);

      enableMarquee(artistDiv);
      enableMarquee(titleDiv);

      const candidates = buildImageCandidatesFor(track, currentFolder);
      setImgSrcWithFallback(imgEl, candidates, DEFAULT_IMAGE);

      imgEl.style.width = "35px";
      imgEl.style.height = "35px";
      imgEl.style.objectFit = "cover";
      imgEl.style.borderRadius = "4px";
      imgEl.style.marginRight = "10px";
      meta.style.display = "flex";
      meta.style.flexDirection = "column";
      meta.style.minWidth = "0";
    }

    const timerEl = document.querySelector(".songTime .timer");
    if (timerEl) timerEl.textContent = "00:00 | 00:00";
    const seekFillEl = document.querySelector(".seekbar .seekFill");
    const circleEl = document.querySelector(".circle");
    if (seekFillEl) seekFillEl.style.width = "0%";
    if (circleEl) circleEl.style.left = "0%";

    clearSongHighlights();
    clearCardHighlights();
    highlightCardForFolder(currentFolder);

    // reset card play icons
    document.querySelectorAll(".card .play img").forEach((img) => {
      if (img) img.src = `${ICON_PATH}/play.svg`;
    });
    const activeCard = document.querySelector(`.card[data-folder="${CSS.escape(currentFolder)}"]`);
    if (activeCard) {
      activeCard.classList.add("playing-card");
      const img = activeCard.querySelector(".play img");
      if (img) img.src = pause ? `${ICON_PATH}/play.svg` : `${ICON_PATH}/pause.svg`;
    }

    // highlight matching li and update its pad icon
    const li = findLiByFilename(track);
    if (li) {
      li.classList.add("playing");
      const btn = getPadPlayImg(li);
      if (btn && btn.tagName && btn.tagName.toLowerCase() === "img") btn.src = pause ? `${ICON_PATH}/play.svg` : `${ICON_PATH}/pause.svg`;
    }

    if (!pause) {
      currentSong.play().catch((err) => {
        console.warn("Playback failed:", err);
      });
      if (playButton) playButton.src = `${ICON_PATH}/pause.svg`;
    } else {
      if (playButton) playButton.src = `${ICON_PATH}/play.svg`;
    }

    fadeVolume(desiredVolume, fadeMs, () => {
      lastUserVolume = Math.max(0, Math.min(1, desiredVolume));
    });
  });
};

// reserve space under content so fixed playbar doesn't cover cards
function reserveForPlaybar() {
  const pb = document.querySelector(".playbar");
  if (!pb) return;
  const h = pb.offsetHeight + 24;
  document.documentElement.style.setProperty("--playbar-h", h + "px");
}

// Ensure playbar stays inside the `.right` container horizontally.
function positionPlaybar() {
  const pb = document.querySelector(".playbar");
  const rightPane = document.querySelector(".right");
  if (!pb || !rightPane) return;

  const rightRect = rightPane.getBoundingClientRect();
  const pbWidth = Math.min(pb.offsetWidth || 0, window.innerWidth - 40);

  let left = Math.round(rightRect.left + Math.max(0, (rightRect.width - pbWidth) / 2));
  const minLeft = 8;
  const maxLeft = Math.max(8, window.innerWidth - pbWidth - 8);
  if (left < minLeft) left = minLeft;
  if (left > maxLeft) left = maxLeft;

  pb.style.left = left + "px";
  pb.style.transform = "none";
}

async function main() {
  reserveForPlaybar();
  window.addEventListener("resize", reserveForPlaybar);
  positionPlaybar();
  window.addEventListener("resize", () => { positionPlaybar(); reserveForPlaybar && reserveForPlaybar(); });

  // DOM refs
  playButton = document.getElementById("playMedia");
  prevButton = document.getElementById("previous");
  nextButton = document.getElementById("next");

  const songUL = document.querySelector(".songList").getElementsByTagName("ul")[0];
  const timerEl = document.querySelector(".songTime .timer");
  const seekbarEl = document.querySelector(".seekbar");
  const seekFillEl = seekbarEl ? seekbarEl.querySelector(".seekFill") : null;
  const circleEl = document.querySelector(".circle");
  const volumeIcon = document.querySelector(".volumeRocker img");
  const volSeekbar = document.querySelector(".volSeekbar");
  const volSeekfill = document.querySelector(".volSeekbar .volSeekfill");
  const volCircle = document.querySelector(".volSeekbar .volCircle");

  currentSong.volume = lastUserVolume = 1;
  if (volSeekfill) volSeekfill.style.width = "100%";
  if (volCircle) volCircle.style.left = "100%";
  setInitialTimer();

  const updateVolumeIcon = () => {
    if (!volumeIcon) return;
    const v = typeof currentSong.volume === "number" ? currentSong.volume : lastUserVolume;
    if (v <= 0) volumeIcon.src = `${ICON_PATH}/mute.svg`;
    else if (v < 0.6) volumeIcon.src = `${ICON_PATH}/volume.svg`;
    else volumeIcon.src = `${ICON_PATH}/volumeMax.svg`;
    if (typeof v === "number" && v > 0) lastUserVolume = v;
  };
  updateVolumeIcon();

  // getFolders scrapes directory listing at BASE_SONGS_PATH root and returns folder names.
  async function getFolders() {
    const res = await fetch(`${BASE_SONGS_PATH}/index.json`);
    const html = await res.text();
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const anchors = tmp.getElementsByTagName("a");
    const foldersArr = [];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (!a.href) continue;
      let url;
      try {
        url = new URL(a.getAttribute("href"), window.location.origin);
      } catch (e) {
        continue;
      }
      // marker tuned to your path
      const marker = "/songs/";
      const path = decodeURIComponent(url.pathname || "");
      const idx = path.indexOf(marker);
      if (idx === -1) continue;
      let after = path.slice(idx + marker.length);
      after = after.replace(/^\/+|\/+$/g, "");
      if (!after || after === "..") continue;
      const firstSegment = after.split("/")[0];
      if (!firstSegment) continue;
      if (firstSegment.startsWith(".")) continue;
      if (firstSegment.includes(".")) continue;
      if (!foldersArr.includes(firstSegment)) foldersArr.push(firstSegment);
    }
    return foldersArr;
  }

  // cached folder order used for playlist-next looping
  let foldersOrder = [];
  try { foldersOrder = await getFolders(); } catch (e) { foldersOrder = []; }

  // initial load of Trending songs if available
  try { songs = await getSongs("Trending"); } catch (e) { songs = []; }
  console.log("initial songs:", songs);

  // when a song ends -> advance to next song, next playlist, loop.
  currentSong.addEventListener("ended", async () => {
    try {
      const currentFileEncoded = currentSong.src.split("/").slice(-1)[0] || "";
      const currentFile = decodeURIComponent(currentFileEncoded);
      let index = songs.indexOf(currentFile);
      if (index === -1) {
        if (songs.length > 0) { playMusic(songs[0]); return; }
      }
      // next in same playlist
      if (index + 1 < songs.length) {
        playMusic(songs[index + 1]);
        return;
      }
      // else advance playlist cyclically
      if (!foldersOrder || foldersOrder.length === 0) {
        try { foldersOrder = await getFolders(); } catch (e) { foldersOrder = []; }
      }
      let folderIndex = foldersOrder.indexOf(currentFolder);
      if (folderIndex === -1) folderIndex = 0;
      const nextFolderIndex = (folderIndex + 1) % Math.max(1, foldersOrder.length);
      const nextFolder = foldersOrder.length ? foldersOrder[nextFolderIndex] : null;
      if (nextFolder) {
        const songsFromNext = await getSongs(nextFolder);
        songs = songsFromNext || [];
        if (songs && songs.length) {
          currentFolder = nextFolder;
          // update left song list UI
          if (songUL) {
            songUL.innerHTML = "";
            for (const s of songs) {
              const filename = s;
              const base = filename.replaceAll("%20", " ").replace(/\.mp3$/i, "").trim();
              let artist = "Unknown";
              let title = base;
              const parts = base.split(" - ");
              if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(" - ").trim(); }

              const li = document.createElement("li");
              li.dataset.file = filename;

              const imgEl = document.createElement("img");
              imgEl.alt = "Music image";
              imgEl.className = "thumb";
              imgEl.width = 50; imgEl.height = 50;
              imgEl.style.width = "50px"; imgEl.style.height = "50px";
              imgEl.style.borderRadius = "6px"; imgEl.style.objectFit = "cover"; imgEl.style.flexShrink = "0";
              const candidates = buildImageCandidatesFor(filename, currentFolder);
              setImgSrcWithFallback(imgEl, candidates, DEFAULT_IMAGE);

              const infoDiv = document.createElement("div"); infoDiv.className = "info";
              const titleDiv = document.createElement("div"); titleDiv.textContent = title; titleDiv.style.fontWeight = "700";
              const artistDiv = document.createElement("div"); artistDiv.textContent = artist;
              artistDiv.style.fontSize = "12px"; artistDiv.style.color = "#cfcfcf";
              artistDiv.style.whiteSpace = "nowrap"; artistDiv.style.overflow = "hidden"; artistDiv.style.textOverflow = "ellipsis";
              infoDiv.appendChild(titleDiv); infoDiv.appendChild(artistDiv);

              const playNow = document.createElement("div"); playNow.className = "playnow";
              playNow.innerHTML = `<img class="padPlayBtn" src="${ICON_PATH}/play.svg" alt="Play Now">`;

              li.appendChild(imgEl); li.appendChild(infoDiv); li.appendChild(playNow);
              enableMarquee(artistDiv);

              li.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const file = li.dataset.file;
                if (!file) return;
                const currentFileEncoded2 = currentSong.src.split("/").slice(-1)[0] || "";
                const currentFile2 = decodeURIComponent(currentFileEncoded2);
                if (currentFile2 === file) {
                  if (currentSong.paused) currentSong.play().catch(()=>{});
                  else currentSong.pause();
                } else {
                  currentFolder = currentFolder;
                  playMusic(file);
                }
              });

              const padImgEl = li.querySelector(".padPlayBtn");
              if (padImgEl) {
                padImgEl.addEventListener("click", (ev) => {
                  ev.stopPropagation();
                  const file = li.dataset.file;
                  if (!file) return;
                  const currentFileEncoded2 = currentSong.src.split("/").slice(-1)[0] || "";
                  const currentFile2 = decodeURIComponent(currentFileEncoded2);
                  if (currentFile2 === file) {
                    if (currentSong.paused) currentSong.play().catch(()=>{});
                    else currentSong.pause();
                  } else {
                    currentFolder = currentFolder;
                    playMusic(file);
                  }
                });
                padImgEl.style.transition = "transform 160ms ease";
                padImgEl.addEventListener("mouseenter", () => (padImgEl.style.transform = "scale(1.12)"));
                padImgEl.addEventListener("mouseleave", () => (padImgEl.style.transform = "scale(1)"));
              }

              songUL.appendChild(li);
            }
          }
          playMusic(songs[0]);
        }
      } else {
        // fallback — restart current
        if (songs && songs.length) playMusic(songs[0]);
      }
    } catch (err) {
      console.error("ended handler error:", err);
    }
  });

  // render playlist cards (no default flash — build after metadata fetch)
  const cardContainer = document.querySelector(".cardContainer");
  if (cardContainer) {
    (async () => {
      cardContainer.innerHTML = "";
      const spinner = document.createElement("div");
      spinner.className = "cards-spinner";
      spinner.textContent = "Loading playlists...";
      cardContainer.appendChild(spinner);

      let folders = [];
      try {
        folders = await getFolders();
        if (Array.isArray(folders) && folders.length) foldersOrder = folders;
      } catch (err) {
        console.error("Failed to fetch folders for UI:", err);
        cardContainer.innerHTML = '<div class="no-folders">Playlists unavailable</div>';
        return;
      }

      if (!folders || folders.length === 0) {
        if (spinner && spinner.parentNode) spinner.parentNode.removeChild(spinner);
        cardContainer.innerHTML = '<div class="no-folders">No playlists found</div>';
        return;
      }

      const DEFAULT_COVER = "https://i.scdn.co/image/ab67616d00001e02fb17ca2db5032550091a6f9a";
      const folderInfos = await Promise.all(folders.map(async (folder) => {
        const encodedFolder = encodeURIComponent(folder);
        const folderBase = `${BASE_SONGS_PATH}/${encodedFolder}/`;
        let info = {};
        try {
          const infoRes = await fetch(folderBase + "info.json", { cache: "no-store" });
          if (infoRes && infoRes.ok) {
            info = await infoRes.json();
            if (!info || typeof info !== "object") info = {};
          }
        } catch (err) {}
        let cover = DEFAULT_COVER;
        try {
          const coverUrl = folderBase + "cover.jpeg";
          const head = await fetch(coverUrl, { method: "HEAD" });
          if (head && head.ok) cover = coverUrl;
        } catch (err) {}
        return {
          folder,
          title: info.title && String(info.title).trim() ? String(info.title).trim() : folder,
          desc: info.description && String(info.description).trim() ? String(info.description).trim() : "",
          cover
        };
      }));

      if (spinner && spinner.parentNode) spinner.parentNode.removeChild(spinner);
      const frag = document.createDocumentFragment();

      for (const fi of folderInfos) {
        const d = document.createElement("div");
        d.className = "card";
        d.dataset.folder = fi.folder;
        d.innerHTML = `
          <div class="play">
            <img src="${ICON_PATH}/play.svg" alt="Play Button" />
          </div>
          <img class="card-cover" src="${fi.cover}" alt="Card Img" />
          <h2 class="card-title">${escapeHtml(fi.title)}</h2>
          <p class="card-desc">${escapeHtml(fi.desc)}</p>
        `;

        d.addEventListener("click", async () => {
          const songsFromFolder = await getSongs(fi.folder);
          songs = songsFromFolder;
          if (songUL) {
            songUL.innerHTML = "";
            for (const s of songs) {
              const filename = s;
              const base = filename.replaceAll("%20", " ").replace(/\.mp3$/i, "").trim();
              let artist = "Unknown";
              let title = base;
              const parts = base.split(" - ");
              if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(" - ").trim(); }

              const li = document.createElement("li");
              li.dataset.file = filename;

              const imgEl = document.createElement("img");
              imgEl.alt = "Music image"; imgEl.className = "thumb";
              imgEl.width = 50; imgEl.height = 50;
              imgEl.style.width = "50px"; imgEl.style.height = "50px";
              imgEl.style.borderRadius = "6px"; imgEl.style.objectFit = "cover"; imgEl.style.flexShrink = "0";
              const candidates = buildImageCandidatesFor(filename, fi.folder);
              setImgSrcWithFallback(imgEl, candidates, DEFAULT_IMAGE);

              const infoDiv = document.createElement("div"); infoDiv.className = "info";
              const titleDiv = document.createElement("div"); titleDiv.textContent = title; titleDiv.style.fontWeight = "700";
              const artistDiv = document.createElement("div"); artistDiv.textContent = artist;
              artistDiv.style.fontSize = "12px"; artistDiv.style.color = "#cfcfcf";
              artistDiv.style.whiteSpace = "nowrap"; artistDiv.style.overflow = "hidden"; artistDiv.style.textOverflow = "ellipsis";
              infoDiv.appendChild(titleDiv); infoDiv.appendChild(artistDiv);

              const playNow = document.createElement("div"); playNow.className = "playnow";
              playNow.innerHTML = `<img class="padPlayBtn" src="${ICON_PATH}/play.svg" alt="Play Now">`;

              li.appendChild(imgEl); li.appendChild(infoDiv); li.appendChild(playNow);
              enableMarquee(artistDiv);

              li.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const file = li.dataset.file;
                if (!file) return;
                currentFolder = fi.folder;
                playMusic(file);
              });

              const padImg = li.querySelector(".padPlayBtn");
              if (padImg) {
                padImg.addEventListener("click", (ev) => {
                  ev.stopPropagation();
                  const file = li.dataset.file;
                  if (!file) return;
                  currentFolder = fi.folder;
                  playMusic(file);
                });
                padImg.style.transition = "transform 160ms ease";
                padImg.addEventListener("mouseenter", () => (padImg.style.transform = "scale(1.12)"));
                padImg.addEventListener("mouseleave", () => (padImg.style.transform = "scale(1)"));
              }

              songUL.appendChild(li);
            }
          }
          currentFolder = fi.folder;
          if (songs && songs.length) playMusic(songs[0]);
        });

        const playImg = d.querySelector(".play img");
        if (playImg) {
          playImg.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            const songsFromFolder = await getSongs(fi.folder);
            songs = songsFromFolder;
            currentFolder = fi.folder;

            if (songUL) {
              songUL.innerHTML = "";
              for (const s of songs) {
                const filename = s;
                const base = filename.replaceAll("%20", " ").replace(/\.mp3$/i, "").trim();
                let artist = "Unknown";
                let title = base;
                const parts = base.split(" - ");
                if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(" - ").trim(); }

                const li = document.createElement("li");
                li.dataset.file = filename;

                const imgEl = document.createElement("img");
                imgEl.alt = "Music image"; imgEl.className = "thumb";
                imgEl.width = 50; imgEl.height = 50;
                imgEl.style.width = "50px"; imgEl.style.height = "50px";
                imgEl.style.borderRadius = "6px"; imgEl.style.objectFit = "cover"; imgEl.style.flexShrink = "0";
                const candidates = buildImageCandidatesFor(filename, fi.folder);
                setImgSrcWithFallback(imgEl, candidates, DEFAULT_IMAGE);

                const infoDiv = document.createElement("div"); infoDiv.className = "info";
                const titleDiv = document.createElement("div"); titleDiv.textContent = title; titleDiv.style.fontWeight = "700";
                const artistDiv = document.createElement("div"); artistDiv.textContent = artist;
                artistDiv.style.fontSize = "12px"; artistDiv.style.color = "#cfcfcf";
                artistDiv.style.whiteSpace = "nowrap"; artistDiv.style.overflow = "hidden"; artistDiv.style.textOverflow = "ellipsis";
                infoDiv.appendChild(titleDiv); infoDiv.appendChild(artistDiv);

                const playNow = document.createElement("div"); playNow.className = "playnow";
                playNow.innerHTML = `<img class="padPlayBtn" src="${ICON_PATH}/play.svg" alt="Play Now">`;

                li.appendChild(imgEl); li.appendChild(infoDiv); li.appendChild(playNow);
                enableMarquee(artistDiv);

                li.addEventListener("click", (ev2) => {
                  ev2.stopPropagation();
                  const file = li.dataset.file;
                  if (!file) return;
                  currentFolder = fi.folder;
                  playMusic(file);
                });

                const padImg = li.querySelector(".padPlayBtn");
                if (padImg) {
                  padImg.addEventListener("click", (ev3) => {
                    ev3.stopPropagation();
                    const file = li.dataset.file;
                    if (!file) return;
                    currentFolder = fi.folder;
                    playMusic(file);
                  });
                  padImg.style.transition = "transform 160ms ease";
                  padImg.addEventListener("mouseenter", () => (padImg.style.transform = "scale(1.12)"));
                  padImg.addEventListener("mouseleave", () => (padImg.style.transform = "scale(1)"));
                }

                songUL.appendChild(li);
              }
            }

            if (songs && songs.length) playMusic(songs[0]);
          });
        }

        frag.appendChild(d);
      }

      cardContainer.appendChild(frag);
    })();
  }

  // initial left playlist render (Trending)
  if (songUL) {
    songUL.innerHTML = "";
    for (const song of songs) {
      const filename = song;
      const base = filename.replaceAll("%20", " ").replace(/\.mp3$/i, "").trim();
      let artist = "Unknown";
      let title = base;
      const parts = base.split(" - ");
      if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(" - ").trim(); }

      const li = document.createElement("li");
      li.dataset.file = filename;

      const imgEl = document.createElement("img");
      imgEl.alt = "Music image"; imgEl.className = "thumb";
      imgEl.width = 50; imgEl.height = 50;
      imgEl.style.width = "50px"; imgEl.style.height = "50px";
      imgEl.style.borderRadius = "6px"; imgEl.style.objectFit = "cover"; imgEl.style.flexShrink = "0";
      const candidates = buildImageCandidatesFor(filename, currentFolder || "Trending");
      setImgSrcWithFallback(imgEl, candidates, DEFAULT_IMAGE);

      const infoDiv = document.createElement("div"); infoDiv.className = "info";
      const titleDiv = document.createElement("div"); titleDiv.textContent = title; titleDiv.style.fontWeight = "700";
      const artistDiv = document.createElement("div"); artistDiv.textContent = artist;
      artistDiv.style.fontSize = "12px"; artistDiv.style.color = "#cfcfcf";
      artistDiv.style.whiteSpace = "nowrap"; artistDiv.style.overflow = "hidden"; artistDiv.style.textOverflow = "ellipsis";
      infoDiv.appendChild(titleDiv); infoDiv.appendChild(artistDiv);

      const playNow = document.createElement("div"); playNow.className = "playnow";
      playNow.innerHTML = `<img class="padPlayBtn" src="${ICON_PATH}/play.svg" alt="Play Now">`;

      li.appendChild(imgEl); li.appendChild(infoDiv); li.appendChild(playNow);
      enableMarquee(artistDiv);

      // toggle behavior on li click
      li.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const file = li.dataset.file;
        if (!file) return;
        const currentFileEncoded = currentSong.src.split("/").slice(-1)[0] || "";
        const currentFile = decodeURIComponent(currentFileEncoded);
        if (currentFile === file) {
          if (currentSong.paused) currentSong.play().catch(()=>{});
          else currentSong.pause();
        } else {
          playMusic(file);
        }
      });

      // pad button click behavior
      const padImg = li.querySelector(".padPlayBtn");
      if (padImg) {
        padImg.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const file = li.dataset.file;
          if (!file) return;
          const currentFileEncoded = currentSong.src.split("/").slice(-1)[0] || "";
          const currentFile = decodeURIComponent(currentFileEncoded);
          if (currentFile === file) {
            if (currentSong.paused) currentSong.play().catch(()=>{});
            else currentSong.pause();
          } else {
            playMusic(file);
          }
        });
        padImg.style.transition = "transform 160ms ease";
        padImg.addEventListener("mouseenter", () => (padImg.style.transform = "scale(1.12)"));
        padImg.addEventListener("mouseleave", () => (padImg.style.transform = "scale(1)"));
      }

      songUL.appendChild(li);
    }
  }

  // ensure first trending track loads (paused)
  if (songs && songs.length) {
    if (!currentFolder) currentFolder = "Trending";
    playMusic(songs[0], true);
  }

  // play/pause main button
  if (playButton) {
    playButton.addEventListener("click", () => {
      if (!currentSong.src || currentSong.src === "") {
        if (songs && songs.length) {
          if (!currentFolder) currentFolder = "Trending";
          playMusic(songs[0]);
          return;
        }
      }
      if (currentSong.paused) currentSong.play().catch(()=>{});
      else currentSong.pause();
    });
  }

  // update icons & highlights on play/pause events
  currentSong.addEventListener("play", () => {
    if (playButton) playButton.src = `${ICON_PATH}/pause.svg`;
    const currentFileEncoded = currentSong.src.split("/").slice(-1)[0] || "";
    const currentFile = decodeURIComponent(currentFileEncoded);
    clearSongHighlights();
    const li = findLiByFilename(currentFile);
    if (li) {
      li.classList.add("playing");
      const btn = getPadPlayImg(li);
      if (btn && btn.tagName && btn.tagName.toLowerCase() === "img") btn.src = `${ICON_PATH}/pause.svg`;
    }
    clearCardHighlights();
    const card = document.querySelector(`.card[data-folder="${CSS.escape(currentFolder)}"]`);
    if (card) {
      card.classList.add("playing-card");
      const pimg = card.querySelector(".play img");
      if (pimg) pimg.src = `${ICON_PATH}/pause.svg`;
    }
  });

  currentSong.addEventListener("pause", () => {
    if (playButton) playButton.src = `${ICON_PATH}/play.svg`;
    const currentFileEncoded = currentSong.src.split("/").slice(-1)[0] || "";
    const currentFile = decodeURIComponent(currentFileEncoded);
    const li = findLiByFilename(currentFile);
    if (li) {
      const btn = getPadPlayImg(li);
      if (btn && btn.tagName && btn.tagName.toLowerCase() === "img") btn.src = `${ICON_PATH}/play.svg`;
      li.classList.remove("playing");
    }
    const card = document.querySelector(`.card[data-folder="${CSS.escape(currentFolder)}"]`);
    if (card) {
      const pimg = card.querySelector(".play img");
      if (pimg) pimg.src = `${ICON_PATH}/play.svg`;
    }
  });

  // timeupdate updates timer + seek UI
  currentSong.addEventListener("timeupdate", () => {
    const cur = currentSong.currentTime || 0;
    const dur = currentSong.duration;
    if (timerEl) timerEl.textContent = `${secondsToMinutesSeconds(cur)} | ${secondsToMinutesSeconds(dur)}`;
    const pct = isFinite(dur) && dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
    if (circleEl) circleEl.style.left = pct + "%";
    if (seekFillEl) seekFillEl.style.width = pct + "%";
  });

  // seekbar interactions (click/drag)
  if (seekbarEl) {
    seekbarEl.addEventListener("click", (e) => {
      const rect = seekbarEl.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, clickX / rect.width));
      if (circleEl) circleEl.style.left = percent * 100 + "%";
      if (seekFillEl) seekFillEl.style.width = percent * 100 + "%";
      if (isFinite(currentSong.duration) && currentSong.duration > 0) currentSong.currentTime = currentSong.duration * percent;
    });

    let isDragging = false;
    let pendingSeekPercent = null;
    let wasPlayingBeforeDrag = false;

    const updateUIFromClientX = (clientX) => {
      const rect = seekbarEl.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const pct = x / rect.width;
      const pct100 = pct * 100;
      if (circleEl) circleEl.style.left = pct100 + "%";
      if (seekFillEl) seekFillEl.style.width = pct100 + "%";
      const dur = currentSong.duration;
      if (timerEl) {
        if (isFinite(dur) && dur > 0) {
          const fakeTime = dur * pct;
          timerEl.textContent = `${secondsToMinutesSeconds(fakeTime)} | ${secondsToMinutesSeconds(dur)}`;
        } else {
          timerEl.textContent = `00:00 | ${secondsToMinutesSeconds(dur)}`;
        }
      }
      pendingSeekPercent = pct;
    };

    if (circleEl) circleEl.addEventListener("mousedown", (e) => { isDragging = true; wasPlayingBeforeDrag = !currentSong.paused; e.preventDefault(); });
    seekbarEl.addEventListener("mousedown", (e) => { isDragging = true; wasPlayingBeforeDrag = !currentSong.paused; updateUIFromClientX(e.clientX); e.preventDefault(); });
    window.addEventListener("mousemove", (e) => { if (!isDragging) return; updateUIFromClientX(e.clientX); });
    window.addEventListener("mouseup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      if (isFinite(currentSong.duration) && currentSong.duration > 0 && pendingSeekPercent !== null) currentSong.currentTime = currentSong.duration * pendingSeekPercent;
      if (wasPlayingBeforeDrag) currentSong.play().catch(()=>{});
      pendingSeekPercent = null;
    });

    if (circleEl) circleEl.addEventListener("touchstart", (e) => { isDragging = true; wasPlayingBeforeDrag = !currentSong.paused; e.preventDefault(); }, { passive:false });
    window.addEventListener("touchmove", (e) => { if (!isDragging) return; const t = e.touches[0]; updateUIFromClientX(t.clientX); }, { passive:false });
    window.addEventListener("touchend", () => { if (!isDragging) return; isDragging = false; if (isFinite(currentSong.duration) && currentSong.duration > 0 && pendingSeekPercent !== null) currentSong.currentTime = currentSong.duration * pendingSeekPercent; if (wasPlayingBeforeDrag) currentSong.play().catch(()=>{}); pendingSeekPercent = null; });
  }

  // // hamburger & close
  // const ham = document.querySelector(".hamburger");
  // const closeBtn = document.querySelector(".close");
  // if (ham) ham.addEventListener("click", () => { document.querySelector(".left").style.left = "0"; });
  // if (closeBtn) closeBtn.addEventListener("click", () => { document.querySelector(".left").style.left = "-120%"; });


  // hamburger & close — toggle .open class so CSS can handle z-index/padding
const ham = document.querySelector(".hamburger");
const closeBtn = document.querySelector(".close");
const leftPane = document.querySelector(".left");

if (ham && leftPane) {
  ham.addEventListener("click", () => {
    // add class to show left pane (CSS handles left:0 and z-index)
    leftPane.classList.add("open");
    // ensure left is visually on screen in case other code manipulates style.left
    leftPane.style.left = "0";
    // optional: focus first element or prevent body scroll
    document.body.style.overflow = "hidden";
  });
}

if (closeBtn && leftPane) {
  closeBtn.addEventListener("click", () => {
    leftPane.classList.remove("open");
    leftPane.style.left = "-120%";
    document.body.style.overflow = ""; // restore
  });
}

// also close the left pane if user taps outside it (nice UX)
document.addEventListener("click", (ev) => {
  // if left is open and click happened outside .left and not on hamburger, close it
  if (!leftPane || !leftPane.classList.contains("open")) return;
  const target = ev.target;
  if (target.closest && (target.closest(".left") || target.closest(".hamburger"))) return;
  leftPane.classList.remove("open");
  leftPane.style.left = "-120%";
  document.body.style.overflow = "";
});




  // prev & next buttons
  if (prevButton) {
    prevButton.addEventListener("click", () => {
      const currentFileEncoded = currentSong.src.split("/").slice(-1)[0] || "";
      const currentFile = decodeURIComponent(currentFileEncoded);
      let index = songs.indexOf(currentFile);
      if (index === -1) index = 0;
      if (index - 1 >= 0) {
        index = index - 1;
        playMusic(songs[index]);
      } else {
        playMusic(songs[0]);
      }
    });
  }
  if (nextButton) {
    nextButton.addEventListener("click", () => {
      const currentFileEncoded = currentSong.src.split("/").slice(-1)[0] || "";
      const currentFile = decodeURIComponent(currentFileEncoded);
      let index = songs.indexOf(currentFile);
      if (index === -1) index = 0;
      if (index + 1 < songs.length) index = index + 1;
      else index = 0;
      playMusic(songs[index]);
    });
  }

  // VOLUME wiring
  const volSeekbarEl = volSeekbar;
  const volSeekfillEl = volSeekfill;
  const volCircleEl = volCircle;
  if (volSeekbarEl && volSeekfillEl && volCircleEl) {
    volSeekbarEl.addEventListener("click", (e) => {
      const rect = volSeekbarEl.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, clickX / rect.width));
      const pct100 = pct * 100;
      volSeekfillEl.style.width = pct100 + "%";
      volCircleEl.style.left = pct100 + "%";
      currentSong.volume = pct;
      if (pct > 0) lastUserVolume = pct;
      updateVolumeIcon();
    });

    let dragging = false;
    volCircleEl.addEventListener("mousedown", (e) => { dragging = true; e.preventDefault(); });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = volSeekbarEl.getBoundingClientRect();
      const moveX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const pct = moveX / rect.width;
      const pct100 = pct * 100;
      volSeekfillEl.style.width = pct100 + "%";
      volCircleEl.style.left = pct100 + "%";
      currentSong.volume = pct;
      if (pct > 0) lastUserVolume = pct;
      updateVolumeIcon();
    });
    window.addEventListener("mouseup", () => { dragging = false; });

    volCircleEl.addEventListener("touchstart", (e) => { dragging = true; e.preventDefault(); }, { passive:false });
    window.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      const rect = volSeekbarEl.getBoundingClientRect();
      const moveX = Math.max(0, Math.min(rect.width, t.clientX - rect.left));
      const pct = moveX / rect.width;
      const pct100 = pct * 100;
      volSeekfillEl.style.width = pct100 + "%";
      volCircleEl.style.left = pct100 + "%";
      currentSong.volume = pct; if (pct > 0) lastUserVolume = pct;
      updateVolumeIcon();
    }, { passive:false });
    window.addEventListener("touchend", () => { dragging = false; });
  }

  // mute/unmute
  let prevVolForMute = 1;
  const volIcon = document.querySelector(".volumeRocker img");
  if (volIcon) {
    volIcon.addEventListener("click", () => {
      if (!volIcon.src.includes("mute.svg")) {
        prevVolForMute = currentSong.volume || lastUserVolume || 1;
        currentSong.volume = 0;
        volIcon.src = `${ICON_PATH}/mute.svg`;
      } else {
        currentSong.volume = prevVolForMute || lastUserVolume || 1;
        volIcon.src = currentSong.volume < 0.6 ? `${ICON_PATH}/volume.svg` : `${ICON_PATH}/volumeMax.svg`;
      }
      const fill = document.querySelector(".volSeekfill");
      const circle = document.querySelector(".volCircle");
      if (fill) fill.style.width = (currentSong.volume * 100) + "%";
      if (circle) circle.style.left = (currentSong.volume * 100) + "%";
      if (currentSong.volume > 0) lastUserVolume = currentSong.volume;
    });
  }

  // header opacity on scroll inside right pane
  const rightPane = document.querySelector(".spotifyPlaylists");
  if (rightPane) {
    rightPane.addEventListener("scroll", () => {
      const header = document.querySelector(".header");
      if (!header) return;
      const scrollY = rightPane.scrollTop;
      const opacity = Math.min(0.85, 0.5 + scrollY / 400);
      header.style.backgroundColor = `rgba(34, 34, 34, ${opacity})`;
    });
  }
} // end main

main().catch((err) => console.error(err));

