// GlitchOut mobile - own copy of the glitch pipeline.
// Copied from src/glitch.js (extension v1.0.0) on 2026-11-10 so the phone
// app stands on its own. Changes here never touch the extension, and fixes
// in src/glitch.js are not picked up automatically.
//
// GlitchOut - the glitch pipeline (runs in the page's main world).
//
//   real camera -> <video> -> <canvas> (we draw badly on purpose)
//               -> canvas.captureStream() -> the call app
//
// The app only ever sees the canvas stream, so it believes whatever we paint.

(() => {
  'use strict';

  const CLEAN_FPS = 30;
  const STATS_EVERY_MS = 500;
  const STALL_WARNING_MS = 3000;

  // Shown until the first camera frame arrives. If you ever see these bars in
  // a call, the canvas plumbing works but the camera picture is missing.
  const TEST_BARS = [
    { color: '#2ee6ff', x: 0.17, y: 0.26, w: 0.56, h: 0.12 },
    { color: '#ff2e88', x: 0.27, y: 0.44, w: 0.62, h: 0.12 },
    { color: '#f2f4ff', x: 0.17, y: 0.62, w: 0.38, h: 0.12 },
  ];

  // Mix between two numbers: t = 0 gives a, t = 1 gives b.
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Constraints may be a plain number or a wish list like {ideal: 1280}.
  function wantedNumber(value) {
    if (typeof value === 'number') return value;
    if (value && typeof value === 'object') {
      return value.exact ?? value.ideal ?? value.max ?? value.min ?? null;
    }
    return null;
  }

  // `onStats` is optional and only used by test/playground.html.
  function glitchVideoTrack(track, state, onStats) {
    const settings = track.getSettings();
    const startedAt = performance.now();

    // A hidden <video> plays the real camera picture for us.
    // It has to stay inside the document - Chrome may stop decoding frames for
    // a detached element - and it must not be display:none for the same
    // reason. So we park it off-screen where nobody can see it.
    const video = document.createElement('video');
    video.srcObject = new MediaStream([track]);
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.style.cssText =
      'position:fixed;top:0;left:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;';
    (document.body || document.documentElement).appendChild(video);

    const started = video.play();
    if (started && started.catch) {
      started.catch((error) => {
        // AbortError just means the call app closed the camera again before
        // the hidden video got going - apps often open it for a split second
        // to check it. Harmless, so we do not report it as a problem.
        if (error.name === 'AbortError') return;
        console.warn('[GlitchOut] hidden video:', error.name);
      });
    }

    const canvas = document.createElement('canvas');
    canvas.width = settings.width || 640;
    canvas.height = settings.height || 480;
    const ctx = canvas.getContext('2d', { alpha: false });

    function resizeToVideo() {
      if (video.videoWidth && video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
    }

    video.addEventListener('loadedmetadata', resizeToVideo);
    video.addEventListener('resize', resizeToVideo);

    function drawTestPattern() {
      ctx.fillStyle = '#14141f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const bar of TEST_BARS) {
        ctx.fillStyle = bar.color;
        ctx.fillRect(
          bar.x * canvas.width,
          bar.y * canvas.height,
          bar.w * canvas.width,
          bar.h * canvas.height
        );
      }
    }

    drawTestPattern();

    let frameId = 0;
    let lastDrawAt = 0;
    let nextGap = 1000 / CLEAN_FPS;
    let frozenUntil = 0;
    let blackUntil = 0;
    let drawnSinceStats = 0;
    let lastStatsAt = 0;
    let sawFirstFrame = false;
    let warnedAboutStall = false;

    function drawClean() {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      drawnSinceStats++;
    }

    function drawBlack() {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawnSinceStats++;
    }

    // Cut rectangles out of the picture and paste them back in the wrong
    // place - the classic "my video codec gave up" look.
    function drawBlocks(amount) {
      const count = Math.round(1 + amount * 12);
      for (let i = 0; i < count; i++) {
        const w = Math.round(canvas.width * (0.08 + Math.random() * 0.3));
        const h = Math.round(canvas.height * (0.04 + Math.random() * 0.15));
        const x = Math.round(Math.random() * (canvas.width - w));
        const y = Math.round(Math.random() * (canvas.height - h));
        const shift = Math.round((Math.random() - 0.5) * canvas.width * 0.3 * amount);
        ctx.drawImage(canvas, x, y, w, h, x + shift, y, w, h);
      }
    }

    // Shrink the picture into the top left corner, then blow that tiny copy
    // back up to full size. With smoothing turned off the pixels stay as fat
    // squares - exactly like a video stream that ran out of bandwidth.
    function drawPixelated(amount) {
      // `bite` bends the slider so even the middle already looks broken:
      // 50% -> 0.76, 85% -> 0.94. Without it, half the slider does nothing.
      const bite = Math.pow(amount, 0.4);
      const scale = lerp(1, 0.008, bite);
      const w = Math.max(2, Math.round(canvas.width * scale));
      const h = Math.max(2, Math.round(canvas.height * scale));
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(video, 0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(canvas, 0, 0, w, h, 0, 0, canvas.width, canvas.height);
      drawnSinceStats++;
    }

    // Two helper canvases for the colour tear, made the first time we need
    // them. `copy` holds the finished picture, `layer` one colour of it.
    let tearCopy = null;
    let tearLayer = null;

    // Split the picture into its red, green and blue parts and put them back
    // slightly side by side - like an old TV that lost its sync.
    //
    // How we pull out one colour: draw the picture, then "multiply" it with
    // pure red. Multiplying by 0 kills green and blue, multiplying by 1 keeps
    // red. Adding the three layers back together ("lighter") gives the full
    // picture again - unless we nudge them apart first.
    function drawColorTear(amount) {
      if (!tearCopy) {
        tearCopy = document.createElement('canvas');
        tearLayer = document.createElement('canvas');
      }
      for (const helper of [tearCopy, tearLayer]) {
        if (helper.width !== canvas.width) helper.width = canvas.width;
        if (helper.height !== canvas.height) helper.height = canvas.height;
      }
      const copyCtx = tearCopy.getContext('2d');
      const layerCtx = tearLayer.getContext('2d');

      // Usually a small wobble, now and then a big jolt.
      const jolt = Math.random() < 0.1 ? 3 : 1;
      const shift = Math.round(
        canvas.width * 0.025 * amount * (0.5 + Math.random()) * jolt
      );

      copyCtx.drawImage(canvas, 0, 0);

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';

      for (const [color, dx] of [['#f00', -shift], ['#0f0', 0], ['#00f', shift]]) {
        layerCtx.globalCompositeOperation = 'source-over';
        layerCtx.drawImage(tearCopy, 0, 0);
        layerCtx.globalCompositeOperation = 'multiply';
        layerCtx.fillStyle = color;
        layerCtx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(tearLayer, dx, 0);
      }

      ctx.globalCompositeOperation = 'source-over';
    }

    function reportStats(now) {
      if (!onStats || now - lastStatsAt < STATS_EVERY_MS) return;
      onStats({
        drawnFps: Math.round((drawnSinceStats * 1000) / (now - lastStatsAt)),
        frozen: now < frozenUntil,
        readyState: video.readyState,
        paused: video.paused,
        size: `${canvas.width}x${canvas.height}`,
        enabled: state.enabled,
        intensity: state.intensity,
      });
      drawnSinceStats = 0;
      lastStatsAt = now;
    }

    function tick(now) {
      frameId = requestAnimationFrame(tick);
      reportStats(now);

      // No picture to copy yet: keep the test pattern on screen, and shout if
      // the camera never shows up at all.
      if (video.readyState < 2) {
        drawTestPattern();
        if (!warnedAboutStall && performance.now() - startedAt > STALL_WARNING_MS) {
          warnedAboutStall = true;
          console.warn(
            '[GlitchOut] no camera picture after 3s -',
            'readyState:', video.readyState,
            'paused:', video.paused
          );
        }
        return;
      }

      if (!sawFirstFrame) {
        sawFirstFrame = true;
        resizeToVideo();
        console.log('[GlitchOut] first camera frame', `${canvas.width}x${canvas.height}`);
      }

      if (!state.enabled || state.intensity === 0) {
        if (now - lastDrawAt < 1000 / CLEAN_FPS) return;
        lastDrawAt = now;
        drawClean();
        return;
      }

      const amount = state.intensity / 100;
      const effects = state.effects || {};

      // 1. Low frame rate: 30 fps when gentle, down to 1 fps when brutal.
      if (now - lastDrawAt < nextGap) return;
      lastDrawAt = now;

      // Pick the gap to the next frame now, once, instead of rolling the dice
      // on every tick. A real bad line does not drop frames on a tidy
      // schedule - it hitches - so the gap gets a random stretch.
      if (effects.lowFps) {
        const fps = lerp(CLEAN_FPS, 1, Math.pow(amount, 0.6));
        nextGap = (1000 / fps) * (0.4 + Math.random() * 1.2);
      } else {
        nextGap = 1000 / CLEAN_FPS;
      }

      // 2. Blackout: the camera "dies" for a moment.
      if (effects.blackout) {
        if (now < blackUntil) {
          drawBlack();
          return;
        }
        if (Math.random() < 0.01 + amount * 0.04) {
          blackUntil = now + 500 + Math.random() * 3000 * amount;
          drawBlack();
          return;
        }
      }

      // 3. Freeze: we just stop drawing. The canvas keeps its last picture,
      //    so the other side stares at a frozen face.
      if (effects.freeze) {
        if (now < frozenUntil) return;
        if (Math.random() < 0.03 + amount * 0.12) {
          frozenUntil = now + 300 + Math.random() * 2500 * amount;
          return;
        }
      }

      // 4. Draw the picture - chunky if pixelation is on.
      if (effects.pixelate) {
        drawPixelated(amount);
      } else {
        drawClean();
      }

      // 5. Pull the colours apart.
      if (effects.colorTear) drawColorTear(amount);

      // 6. And finally shuffle some rectangles around.
      if (effects.blocks) drawBlocks(amount);
    }

    frameId = requestAnimationFrame(tick);

    const glitched = canvas.captureStream(CLEAN_FPS).getVideoTracks()[0];

    // Call apps and camera test pages ask the track to switch resolution.
    // A canvas track cannot do that and throws OverconstrainedError, which
    // breaks the page. So we take the wish, pass it on to the real camera and
    // resize our canvas to match - the caller gets what it asked for.
    glitched.applyConstraints = async (constraints = {}) => {
      const wanted = constraints.video || constraints;
      const width = wantedNumber(wanted.width);
      const height = wantedNumber(wanted.height);

      try {
        await track.applyConstraints(constraints);
      } catch (error) {
        console.warn('[GlitchOut] camera refused', `${width}x${height}`, '- faking it');
      }

      if (width) canvas.width = width;
      if (height) canvas.height = height;
    };

    // When the call app stops our track, tear the whole pipeline down too,
    // otherwise the camera light would stay on.
    const realStop = glitched.stop.bind(glitched);
    glitched.stop = () => {
      cancelAnimationFrame(frameId);
      video.srcObject = null;
      video.remove();
      track.stop();
      realStop();
    };

    return glitched;
  }

  // A bitcrusher curve. Instead of every in-between value, the sound may only
  // use a few steps - everything else gets rounded off. That is what a cheap
  // digital radio does to a voice, and it sounds dirty on purpose.
  function makeCrushCurve(steps) {
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    return curve;
  }

  // Audio works the same way as video: we build a little chain of boxes the
  // sound has to walk through, and we misbehave in the middle of it.
  //
  //   mic -> gate -+-> dry --------------------------------------> output
  //                |
  //                \-> band -> flanger -> ring -> crush -> wet ---> output
  //
  //   gate     chops the voice in and out
  //   band     throws the deep and the bright parts away (walkie-talkie)
  //   flanger  a very short echo whose delay keeps wobbling
  //   ring     multiplies the voice with a low hum - THE robot trick
  //   crush    rounds the samples off, like a cheap digital radio
  //
  // `onStats` is optional and only used by test/playground.html.
  function glitchAudioTrack(track, state, onStats) {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const destination = context.createMediaStreamDestination();

    const gate = context.createGain();      // the on/off switch for the voice
    const dry = context.createGain();       // the normal sound
    const wet = context.createGain();       // the robot sound

    // Walkie-talkie band: only the middle of the voice survives.
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1300;
    band.Q.value = 0.9;

    const delay = context.createDelay(0.05);
    const feedback = context.createGain();
    const wobble = context.createOscillator();
    const wobbleDepth = context.createGain();

    delay.delayTime.value = 0.006;  // 6ms, far shorter than an echo
    feedback.gain.value = 0.65;
    wobble.frequency.value = 2;
    wobbleDepth.gain.value = 0.003;

    // Ring modulator. A GainNode multiplies whatever comes in by its gain - so
    // if we feed an oscillator into the gain itself, the hum and the voice get
    // multiplied together. That is the sound every robot in every old film has.
    // ring.gain = 1 - mix, ringDepth = mix: at mix 0 the voice passes through
    // untouched, at mix 1 it is pure robot.
    const ring = context.createGain();
    const ringOsc = context.createOscillator();
    const ringDepth = context.createGain();

    ring.gain.value = 1;
    ringOsc.type = 'sine';
    ringOsc.frequency.value = 45;
    ringDepth.gain.value = 0;

    const crush = context.createWaveShaper();
    crush.curve = makeCrushCurve(7);
    crush.oversample = '4x';

    dry.gain.value = 1;
    wet.gain.value = 0;

    source.connect(gate);
    gate.connect(dry).connect(destination);

    gate.connect(band);
    band.connect(delay);
    delay.connect(feedback).connect(delay);  // the echo feeds itself
    band.connect(ring);                      // straight part of the flanger
    delay.connect(ring);                     // wobbling part of the flanger
    ring.connect(crush).connect(wet).connect(destination);

    wobble.connect(wobbleDepth).connect(delay.delayTime);
    ringOsc.connect(ringDepth).connect(ring.gain);
    wobble.start();
    ringOsc.start();

    let gateTimer = 0;

    // The gate loop: decide "silent or not", slide the volume there, then come
    // back after a random amount of time and decide again.
    function gateLoop() {
      wakeUpContext();
      const amount = state.enabled ? state.intensity / 100 : 0;
      const effects = state.effects || {};
      const dropAmount = effects.audioDrop ? amount : 0;
      const robotAmount = effects.robot ? amount : 0;
      const now = context.currentTime;

      // The robot voice follows the slider too. The band and the ring eat a
      // lot of volume, so the wet side is turned up above 1 to make up for it.
      const ringMix = robotAmount * 0.9;
      wet.gain.setTargetAtTime(robotAmount * 1.6, now, 0.1);
      dry.gain.setTargetAtTime(1 - robotAmount * 0.9, now, 0.1);
      wobble.frequency.setTargetAtTime(lerp(0.5, 7, robotAmount), now, 0.1);
      ring.gain.setTargetAtTime(1 - ringMix, now, 0.1);
      ringDepth.gain.setTargetAtTime(ringMix, now, 0.1);
      ringOsc.frequency.setTargetAtTime(lerp(25, 85, robotAmount), now, 0.1);

      if (dropAmount === 0) {
        gate.gain.cancelScheduledValues(now);
        gate.gain.setTargetAtTime(1, now, 0.01);
        gateTimer = setTimeout(gateLoop, 200);
        return;
      }

      const silent = Math.random() < 0.15 + dropAmount * 0.45;
      gate.gain.cancelScheduledValues(now);
      gate.gain.setValueAtTime(gate.gain.value, now);
      // 15ms is quick enough to sound broken, slow enough not to click.
      gate.gain.linearRampToValueAtTime(silent ? 0 : 1, now + 0.015);

      const holdMs = silent
        ? 80 + Math.random() * 700 * dropAmount
        : 150 + Math.random() * 900 * (1 - dropAmount);
      gateTimer = setTimeout(gateLoop, holdMs);
    }

    function wakeUpContext() {
      if (context.state !== 'suspended') return;
      context.resume().catch((error) => {
        console.warn('[GlitchOut] audio context will not start:', error.name);
      });
    }

    wakeUpContext();
    gateLoop();

    let statsTimer = 0;
    if (onStats) {
      statsTimer = setInterval(() => {
        onStats({
          context: context.state,
          gate: gate.gain.value,
          robot: wet.gain.value,
          audioDrop: Boolean((state.effects || {}).audioDrop),
          robotOn: Boolean((state.effects || {}).robot),
        });
      }, 250);
    }

    const glitched = destination.stream.getAudioTracks()[0];

    const realStopAudio = glitched.stop.bind(glitched);
    glitched.stop = () => {
      clearTimeout(gateTimer);
      clearInterval(statsTimer);
      try {
        wobble.stop();
        ringOsc.stop();
      } catch (error) {
        // already stopped, nothing to do
      }
      context.close().catch(() => {});
      track.stop();
      realStopAudio();
    };

    return glitched;
  }

  window.__glitchoutGlitchVideoTrack = glitchVideoTrack;
  window.__glitchoutGlitchAudioTrack = glitchAudioTrack;
})();
