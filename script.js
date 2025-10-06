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
let _fadeRaf = null;

// track last user-set volume so fade-in can restore to it reliably
let lastUserVolume = 1;

// Paths used in repo: /songs and svg/
const BASE_SONGS_PATH = "/songs"; // relative path served by static hosting
const ICON_PATH = "svg"; // folder where svgs live

const DEFAULT_IMAGE = ICON_PATH + "/music.svg";
const IMAGE_EXT_CANDIDATES = [".jpeg", ".jpg", ".png"];

// build candidate image URLs for an mp3 filename inside a folder
function buildImageCandidatesFor(mp3Filename, folder) {
  const base = mp3Filename
    .replace(/\.mp3$/i, "")
    .replaceAll("%20", " ")
    .trim();
  const encodedFolder = encodeURIComponent(folder);
  return IMAGE_EXT_CANDIDATES.map(
    (ext) =>
      `${BASE_SONGS_PATH}/${encodedFolder}/${encodeURIComponent(base + ext)}`
  );
}

// set img src with fallback candidates. If none available use finalFallback.
function setImgSrcWithFallback(
  imgEl,
  srcCandidates = [],
  finalFallback = DEFAULT_IMAGE
) {
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

/*
  enableMarquee(container)
  - wraps content in .marquee-inner if needed
  - measures after next paint frames to get accurate widths
  - creates a Web Animations API alternating animation when overflowed
*/
function enableMarquee(container) {
  if (!container || !(container instanceof HTMLElement)) return;

  // ensure we have an inner wrapper
  let inner = container.querySelector(".marquee-inner");
  if (!inner) {
    inner = document.createElement("span");
    inner.className = "marquee-inner";
    // move children into inner
    while (container.firstChild) inner.appendChild(container.firstChild);
    container.appendChild(inner);
  }

  // cancel previous animation if any
  if (container._marqueeAnim) {
    try {
      container._marqueeAnim.cancel();
    } catch (e) {}
    container._marqueeAnim = null;
  }
  // reset transform before measuring
  inner.style.transform = "translateX(0)";

  // measure after paint to ensure accurate widths (use 2 RAFs to be safe)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const innerWidth = inner.scrollWidth;
      const containerWidth = container.clientWidth;

      if (innerWidth > containerWidth + 4) {
        const shift = -(innerWidth - containerWidth); // negative px
        const durationSec = Math.max(4, Math.min(20, Math.abs(shift) / 25)); // seconds
        const duration = durationSec * 1000;

        const anim = inner.animate(
          [
            { transform: "translateX(0)" },
            { transform: `translateX(${shift}px)` },
          ],
          {
            duration,
            iterations: Infinity,
            direction: "alternate",
            easing: "linear",
          }
        );
        container._marqueeAnim = anim;
      } else {
        try {
          inner.style.transform = "translateX(0)";
        } catch (e) {}
      }
    });
  });
}

function setInitialTimer() {
  const timerEl = document.querySelector(".songTime .timer");
  if (timerEl) timerEl.textContent = "00:00 | 00:00";
}

async function getSongs(folder) {
  currentFolder = folder;
  const listUrl = `${BASE_SONGS_PATH}/${encodeURIComponent(folder)}/`;
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

const fadeVolume = (to, duration = 2000, cb) => {
  if (_fadeRaf) {
    cancelAnimationFrame(_fadeRaf);
    _fadeRaf = null;
  }
  const start = performance.now();
  const from = isFinite(currentSong.volume)
    ? currentSong.volume
    : lastUserVolume || 1;
  const delta = to - from;
  if (duration <= 0) {
    currentSong.volume = Math.max(0, Math.min(1, to));
    if (cb) cb();
    return;
  }
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const v = from + delta * t;
    currentSong.volume = Math.max(0, Math.min(1, v));
    if (t < 1) {
      _fadeRaf = requestAnimationFrame(step);
    } else {
      _fadeRaf = null;
      if (cb) cb();
    }
  };
  _fadeRaf = requestAnimationFrame(step);
};

// helpers for UI highlight management
function clearSongHighlights() {
  document
    .querySelectorAll(".songList ul li.playing")
    .forEach((li) => li.classList.remove("playing"));
  document.querySelectorAll(".songList ul li .padPlayBtn").forEach((btn) => {
    if (btn.tagName && btn.tagName.toLowerCase() === "img")
      btn.src = `${ICON_PATH}/play.svg`;
  });
}
function clearCardHighlights() {
  document
    .querySelectorAll(".card.playing-card")
    .forEach((c) => c.classList.remove("playing-card"));
}
function findLiByFilename(filename) {
  if (!filename) return null;
  return document.querySelector(
    `.songList ul li[data-file="${CSS.escape(filename)}"]`
  );
}
function getPadPlayImg(li) {
  if (!li) return null;
  return li.querySelector(".padPlayBtn");
}
function highlightCardForFolder(folder) {
  clearCardHighlights();
  if (!folder) return;
  const card = document.querySelector(
    `.card[data-folder="${CSS.escape(folder)}"]`
  );
  if (card) card.classList.add("playing-card");
}

const playMusic = (track, pause = false, fadeMs = 1000) => {
  if (!currentFolder) {
    console.warn(
      "playMusic: currentFolder is not set. Call getSongs(folder) first."
    );
    return;
  }

  if (!/\.mp3$/i.test(track)) track = track + ".mp3";

  const url =
    `${BASE_SONGS_PATH}/${encodeURIComponent(currentFolder)}/` +
    encodeURIComponent(track);

  const desiredVolume =
    typeof currentSong.volume === "number" && currentSong.volume > 0
      ? currentSong.volume
      : lastUserVolume || 1;

  fadeVolume(0, fadeMs, () => {
    try {
      currentSong.pause();
    } catch (e) {}
    currentSong.src = url;
    currentSong.volume = 0;

    const infoEl = document.querySelector(".songInfo");
    if (infoEl) {
      const base = track
        .replace(/\.mp3$/i, "")
        .replaceAll("%20", " ")
        .trim();
      let artist = "";
      let title = base;
      const parts = base.split(" - ");
      if (parts.length >= 2) {
        artist = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
      }

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
    const activeCard = document.querySelector(
      `.card[data-folder="${CSS.escape(currentFolder)}"]`
    );
    if (activeCard) {
      activeCard.classList.add("playing-card");
      const img = activeCard.querySelector(".play img");
      if (img)
        img.src = pause ? `${ICON_PATH}/play.svg` : `${ICON_PATH}/pause.svg`;
    }

    // highlight matching li and update its pad icon
    const li = findLiByFilename(track);
    if (li) {
      li.classList.add("playing");
      const btn = getPadPlayImg(li);
      if (btn && btn.tagName && btn.tagName.toLowerCase() === "img")
        btn.src = pause ? `${ICON_PATH}/play.svg` : `${ICON_PATH}/pause.svg`;
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

  let left = Math.round(
    rightRect.left + Math.max(0, (rightRect.width - pbWidth) / 2)
  );

  const minLeft = 8;
  const maxLeft = Math.max(8, window.innerWidth - pbWidth - 8);
  if (left < minLeft) left = minLeft;
  if (left > maxLeft) left = maxLeft;

  pb.style.left = left + "px";
  pb.style.transform = "none";
}

async function main() {
  // setup playbar reservation and positioning
  reserveForPlaybar();
  window.addEventListener("resize", reserveForPlaybar);
  positionPlaybar();
  window.addEventListener("resize", () => {
    positionPlaybar();
    reserveForPlaybar && reserveForPlaybar();
  });

  // load songs from Trending initially (folder name "Trending" expected)
  songs = await getSongs("Trending");
  console.log("songs:", songs);

  // DOM refs
  playButton = document.getElementById("playMedia");
  prevButton = document.getElementById("previous");
  nextButton = document.getElementById("next");

  const songUL = document
    .querySelector(".songList")
    .getElementsByTagName("ul")[0];
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
    const v =
      typeof currentSong.volume === "number"
        ? currentSong.volume
        : lastUserVolume;
    if (v <= 0) volumeIcon.src = `${ICON_PATH}/mute.svg`;
    else if (v < 0.6) volumeIcon.src = `${ICON_PATH}/volume.svg`;
    else volumeIcon.src = `${ICON_PATH}/volumeMax.svg`;
    if (typeof v === "number" && v > 0) lastUserVolume = v;
  };
  updateVolumeIcon();

  async function getFolders() {
    const res = await fetch(`${BASE_SONGS_PATH}/`);
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

  // render playlist cards
  const cardContainer = document.querySelector(".cardContainer");
  if (cardContainer) {
    (async () => {
      const folders = await getFolders();
      cardContainer.innerHTML = "";
      for (const folder of folders) {
        const d = document.createElement("div");
        d.className = "card";
        d.dataset.folder = folder;

        const defaultTitle = folder;
        const defaultDesc = "No description available.";
        const defaultCover =
          "https://i.scdn.co/image/ab67616d00001e02fb17ca2db5032550091a6f9a";
        const encodedFolder = encodeURIComponent(folder);
        const folderBase = `${BASE_SONGS_PATH}/${encodedFolder}/`;

        d.innerHTML = `
          <div class="play">
            <img src="${ICON_PATH}/play.svg" alt="Play Button" />
          </div>
          <img class="card-cover" src="${defaultCover}" alt="Card Img" />
          <h2 class="card-title">${escapeHtml(defaultTitle)}</h2>
          <p class="card-desc">${escapeHtml(defaultDesc)}</p>
        `;
        cardContainer.appendChild(d);

        (async () => {
          try {
            const infoRes = await fetch(folderBase + "info.json");
            let info = {};
            if (infoRes.ok) info = await infoRes.json();
            const title =
              info.title && String(info.title).trim()
                ? info.title
                : defaultTitle;
            const desc =
              info.description && String(info.description).trim()
                ? info.description
                : defaultDesc;
            const coverUrl = folderBase + "cover.jpeg";
            const imgEl = d.querySelector(".card-cover");
            const h2El = d.querySelector(".card-title");
            const pEl = d.querySelector(".card-desc");
            if (imgEl) {
              try {
                const head = await fetch(coverUrl, { method: "HEAD" });
                if (head.ok) imgEl.src = coverUrl;
                else imgEl.src = defaultCover;
              } catch (err) {
                imgEl.src = defaultCover;
              }
            }
            if (h2El) h2El.textContent = title;
            if (pEl) pEl.textContent = desc;
          } catch (err) {}
        })();

        // clicking the card loads that folder into left list and loads first track (play)
        d.addEventListener("click", async () => {
          const songsFromFolder = await getSongs(folder);
          songs = songsFromFolder;
          if (songUL) {
            songUL.innerHTML = "";
            for (const s of songs) {
              const filename = s;
              const base = filename
                .replaceAll("%20", " ")
                .replace(/\.mp3$/i, "")
                .trim();
              let artist = "Unknown";
              let title = base;
              const parts = base.split(" - ");
              if (parts.length >= 2) {
                artist = parts[0].trim();
                title = parts.slice(1).join(" - ").trim();
              }

              const li = document.createElement("li");
              li.dataset.file = filename;

              const imgEl = document.createElement("img");
              imgEl.alt = "Music image";
              imgEl.className = "thumb";
              imgEl.width = 50;
              imgEl.height = 50;
              imgEl.style.width = "50px";
              imgEl.style.height = "50px";
              imgEl.style.borderRadius = "6px";
              imgEl.style.objectFit = "cover";
              imgEl.style.flexShrink = "0";
              const candidates = buildImageCandidatesFor(filename, folder);
              setImgSrcWithFallback(imgEl, candidates, DEFAULT_IMAGE);

              const infoDiv = document.createElement("div");
              infoDiv.className = "info";
              const titleDiv = document.createElement("div");
              titleDiv.textContent = title;
              titleDiv.style.fontWeight = "700";
              const artistDiv = document.createElement("div");
              artistDiv.textContent = artist;
              artistDiv.style.fontSize = "12px";
              artistDiv.style.color = "#cfcfcf";
              artistDiv.style.whiteSpace = "nowrap";
              artistDiv.style.overflow = "hidden";
              artistDiv.style.textOverflow = "ellipsis";
              infoDiv.appendChild(titleDiv);
              infoDiv.appendChild(artistDiv);

              const playNow = document.createElement("div");
              playNow.className = "playnow";
              playNow.innerHTML = `<img class="padPlayBtn" src="${ICON_PATH}/play.svg" alt="Play Now">`;

              li.appendChild(imgEl);
              li.appendChild(infoDiv);
              li.appendChild(playNow);
              enableMarquee(artistDiv);

              li.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const file = li.dataset.file;
                if (!file) return;
                currentFolder = folder;
                playMusic(file);
              });

              songUL.appendChild(li);
            }
          }
          currentFolder = folder;
          if (songs && songs.length) playMusic(songs[0]);
        });

        // small play icon inside card: populate left playlist AND play first track
        const playImg = d.querySelector(".play img");
        if (playImg) {
          playImg.addEventListener("click", async (ev) => {
            ev.stopPropagation();

            const songsFromFolder = await getSongs(folder);
            songs = songsFromFolder;
            currentFolder = folder;

            if (songUL) {
              songUL.innerHTML = "";
              for (const s of songs) {
                const filename = s;
                const base = filename
                  .replaceAll("%20", " ")
                  .replace(/\.mp3$/i, "")
                  .trim();
                let artist = "Unknown";
                let title = base;
                const parts = base.split(" - ");
                if (parts.length >= 2) {
                  artist = parts[0].trim();
                  title = parts.slice(1).join(" - ").trim();
                }

                const li = document.createElement("li");
                li.dataset.file = filename;

                const imgEl = document.createElement("img");
                imgEl.alt = "Music image";
                imgEl.className = "thumb";
                imgEl.width = 50;
                imgEl.height = 50;
                imgEl.style.width = "50px";
                imgEl.style.height = "50px";
                imgEl.style.borderRadius = "6px";
                imgEl.style.objectFit = "cover";
                imgEl.style.flexShrink = "0";
                const candidates = buildImageCandidatesFor(filename, folder);
                setImgSrcWithFallback(imgEl, candidates, DEFAULT_IMAGE);

                const infoDiv = document.createElement("div");
                infoDiv.className = "info";
                const titleDiv = document.createElement("div");
                titleDiv.textContent = title;
                titleDiv.style.fontWeight = "700";
                const artistDiv = document.createElement("div");
                artistDiv.textContent = artist;
                artistDiv.style.fontSize = "12px";
                artistDiv.style.color = "#cfcfcf";
                artistDiv.style.whiteSpace = "nowrap";
                artistDiv.style.overflow = "hidden";
                artistDiv.style.textOverflow = "ellipsis";
                infoDiv.appendChild(titleDiv);
                infoDiv.appendChild(artistDiv);

                const playNow = document.createElement("div");
                playNow.className = "playnow";
                playNow.innerHTML = `<img class="padPlayBtn" src="${ICON_PATH}/play.svg" alt="Play Now">`;

                li.appendChild(imgEl);
                li.appendChild(infoDiv);
                li.appendChild(playNow);
                enableMarquee(artistDiv);

                li.addEventListener("click", (ev2) => {
                  ev2.stopPropagation();
                  const file = li.dataset.file;
                  if (!file) return;
                  currentFolder = folder;
                  playMusic(file);
                });

                const padImg = li.querySelector(".padPlayBtn");
                if (padImg) {
                  padImg.addEventListener("click", (ev3) => {
                    ev3.stopPropagation();
                    const file = li.dataset.file;
                    if (!file) return;
                    currentFolder = folder;
                    playMusic(file);
                  });
                  padImg.style.transition = "transform 160ms ease";
                  padImg.addEventListener(
                    "mouseenter",
                    () => (padImg.style.transform = "scale(1.12)")
                  );
                  padImg.addEventListener(
                    "mouseleave",
                    () => (padImg.style.transform = "scale(1)")
                  );
                }

                songUL.appendChild(li);
              }
            }

            if (songs && songs.length) {
              playMusic(songs[0]);
            }
          });
        }
      }
    })();
  }

  // initial left playlist render (Trending)
  if (songUL) {
    songUL.innerHTML = "";
    for (const song of songs) {
      const filename = song;
      const base = filename
        .replaceAll("%20", " ")
        .replace(/\.mp3$/i, "")
        .trim();
      let artist = "Unknown";
      let title = base;
      const parts = base.split(" - ");
      if (parts.length >= 2) {
        artist = parts[0].trim();
        title = parts.slice(1).join(" - ").trim();
      }

      const li = document.createElement("li");
      li.dataset.file = filename;

      const imgEl = document.createElement("img");
      imgEl.alt = "Music image";
      imgEl.className = "thumb";
      imgEl.width = 50;
      imgEl.height = 50;
      imgEl.style.width = "50px";
      imgEl.style.height = "50px";
      imgEl.style.borderRadius = "6px";
      imgEl.style.objectFit = "cover";
      imgEl.style.flexShrink = "0";
      const candidates = buildImageCandidatesFor(
        filename,
        currentFolder || "Trending"
      );
      setImgSrcWithFallback(imgEl, candidates, DEFAULT_IMAGE);

      const infoDiv = document.createElement("div");
      infoDiv.className = "info";
      const titleDiv = document.createElement("div");
      titleDiv.textContent = title;
      titleDiv.style.fontWeight = "700";
      const artistDiv = document.createElement("div");
      artistDiv.textContent = artist;
      artistDiv.style.fontSize = "12px";
      artistDiv.style.color = "#cfcfcf";
      artistDiv.style.whiteSpace = "nowrap";
      artistDiv.style.overflow = "hidden";
      artistDiv.style.textOverflow = "ellipsis";
      infoDiv.appendChild(titleDiv);
      infoDiv.appendChild(artistDiv);

      const playNow = document.createElement("div");
      playNow.className = "playnow";
      playNow.innerHTML = `<img class="padPlayBtn" src="${ICON_PATH}/play.svg" alt="Play Now">`;

      li.appendChild(imgEl);
      li.appendChild(infoDiv);
      li.appendChild(playNow);
      enableMarquee(artistDiv);

      li.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const file = li.dataset.file;
        if (!file) return;
        const currentFileEncoded =
          currentSong.src.split("/").slice(-1)[0] || "";
        const currentFile = decodeURIComponent(currentFileEncoded);
        if (currentFile === file) {
          if (currentSong.paused) currentSong.play().catch(() => {});
          else currentSong.pause();
        } else {
          playMusic(file);
        }
      });

      songUL.appendChild(li);
    }
  }

  // make sure first trending track loads into playbar (paused)
  if (songs && songs.length) {
    if (!currentFolder) currentFolder = "Trending";
    playMusic(songs[0], true);
  }

  // main play/pause button behavior
  if (playButton) {
    playButton.addEventListener("click", () => {
      if (!currentSong.src || currentSong.src === "") {
        if (songs && songs.length) {
          if (!currentFolder) currentFolder = "Trending";
          playMusic(songs[0]);
          return;
        }
      }
      if (currentSong.paused) currentSong.play().catch(() => {});
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
      if (btn && btn.tagName && btn.tagName.toLowerCase() === "img")
        btn.src = `${ICON_PATH}/pause.svg`;
    }
    clearCardHighlights();
    const card = document.querySelector(
      `.card[data-folder="${CSS.escape(currentFolder)}"]`
    );
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
      if (btn && btn.tagName && btn.tagName.toLowerCase() === "img")
        btn.src = `${ICON_PATH}/play.svg`;
    }
    const card = document.querySelector(
      `.card[data-folder="${CSS.escape(currentFolder)}"]`
    );
    if (card) {
      const pimg = card.querySelector(".play img");
      if (pimg) pimg.src = `${ICON_PATH}/play.svg`;
    }
  });

  // timeupdate updates timer + seek UI
  currentSong.addEventListener("timeupdate", () => {
    const cur = currentSong.currentTime || 0;
    const dur = currentSong.duration;
    if (timerEl)
      timerEl.textContent = `${secondsToMinutesSeconds(
        cur
      )} | ${secondsToMinutesSeconds(dur)}`;
    const pct =
      isFinite(dur) && dur > 0
        ? Math.max(0, Math.min(100, (cur / dur) * 100))
        : 0;
    if (circleEl) circleEl.style.left = pct + "%";
    if (seekFillEl) seekFillEl.style.width = pct + "%";
  });

  // seekbar click & drag (same behavior)
  if (seekbarEl) {
    seekbarEl.addEventListener("click", (e) => {
      const rect = seekbarEl.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, clickX / rect.width));
      if (circleEl) circleEl.style.left = percent * 100 + "%";
      if (seekFillEl) seekFillEl.style.width = percent * 100 + "%";
      if (isFinite(currentSong.duration) && currentSong.duration > 0)
        currentSong.currentTime = currentSong.duration * percent;
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
          timerEl.textContent = `${secondsToMinutesSeconds(
            fakeTime
          )} | ${secondsToMinutesSeconds(dur)}`;
        } else {
          timerEl.textContent = `00:00 | ${secondsToMinutesSeconds(dur)}`;
        }
      }
      pendingSeekPercent = pct;
    };

    if (circleEl) {
      circleEl.addEventListener("mousedown", (e) => {
        isDragging = true;
        wasPlayingBeforeDrag = !currentSong.paused;
        e.preventDefault();
      });
    }
    seekbarEl.addEventListener("mousedown", (e) => {
      isDragging = true;
      wasPlayingBeforeDrag = !currentSong.paused;
      updateUIFromClientX(e.clientX);
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      updateUIFromClientX(e.clientX);
    });
    window.addEventListener("mouseup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      if (
        isFinite(currentSong.duration) &&
        currentSong.duration > 0 &&
        pendingSeekPercent !== null
      )
        currentSong.currentTime = currentSong.duration * pendingSeekPercent;
      if (wasPlayingBeforeDrag) currentSong.play().catch(() => {});
      pendingSeekPercent = null;
    });

    if (circleEl) {
      circleEl.addEventListener(
        "touchstart",
        (e) => {
          isDragging = true;
          wasPlayingBeforeDrag = !currentSong.paused;
          e.preventDefault();
        },
        { passive: false }
      );
    }
    window.addEventListener(
      "touchmove",
      (e) => {
        if (!isDragging) return;
        const t = e.touches[0];
        updateUIFromClientX(t.clientX);
      },
      { passive: false }
    );
    window.addEventListener("touchend", () => {
      if (!isDragging) return;
      isDragging = false;
      if (
        isFinite(currentSong.duration) &&
        currentSong.duration > 0 &&
        pendingSeekPercent !== null
      )
        currentSong.currentTime = currentSong.duration * pendingSeekPercent;
      if (wasPlayingBeforeDrag) currentSong.play().catch(() => {});
      pendingSeekPercent = null;
    });
  }

  // hamburger & close
  const ham = document.querySelector(".hamburger");
  const closeBtn = document.querySelector(".close");
  if (ham)
    ham.addEventListener("click", () => {
      document.querySelector(".left").style.left = "0";
    });
  if (closeBtn)
    closeBtn.addEventListener("click", () => {
      document.querySelector(".left").style.left = "-120%";
    });

  // previous & next
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
    volCircleEl.addEventListener("mousedown", (e) => {
      dragging = true;
      e.preventDefault();
    });
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
    window.addEventListener("mouseup", () => {
      dragging = false;
    });

    volCircleEl.addEventListener(
      "touchstart",
      (e) => {
        dragging = true;
        e.preventDefault();
      },
      { passive: false }
    );
    window.addEventListener(
      "touchmove",
      (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        const rect = volSeekbarEl.getBoundingClientRect();
        const moveX = Math.max(0, Math.min(rect.width, t.clientX - rect.left));
        const pct = moveX / rect.width;
        const pct100 = pct * 100;
        volSeekfillEl.style.width = pct100 + "%";
        volCircleEl.style.left = pct100 + "%";
        currentSong.volume = pct;
        if (pct > 0) lastUserVolume = pct;
        updateVolumeIcon();
      },
      { passive: false }
    );
    window.addEventListener("touchend", () => {
      dragging = false;
    });
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
        volIcon.src =
          currentSong.volume < 0.6
            ? `${ICON_PATH}/volume.svg`
            : `${ICON_PATH}/volumeMax.svg`;
      }
      const fill = document.querySelector(".volSeekfill");
      const circle = document.querySelector(".volCircle");
      if (fill) fill.style.width = currentSong.volume * 100 + "%";
      if (circle) circle.style.left = currentSong.volume * 100 + "%";
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
