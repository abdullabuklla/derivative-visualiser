/****************************************************************
 * Derivative Visualiser — stable-zoom build · July 2025
 * -------------------------------------------------------------
 * • dramatic auto-zoom + pan (point x₀ always kept in view)
 * • purple free-hand slope game; accuracy shown permanently
 * • fireworks + banner for each attempt
 * • stacked L/R histogram, colour-matched secants & trace
 ****************************************************************/

const MAX_ZOOM  = 30000;          // auto-zoom limit
const TRACE_MAX = 1000;        // samples kept for slope trace
const PAD       = 200;          // safe margin when zooming


const ACTIVE_FPS = 60;   // when animating / drawing
const IDLE_FPS   = 12;   // when idle

/* ------------------------------------------------------------------
   Padding factors – tweak to taste
   ------------------------------------------------------------------*/
const X_PAD_FRAC = 0.05;   // 5 % blank space on each horizontal side
const Y_PAD_FRAC = 0.08;   // 8 % blank space above & below the curve


const $ = id => document.getElementById(id);

/* declare refresh FIRST so listeners never see “undefined” */
let mainC;                     // defined later in setup()

let latestStroke = null;    // {pts: [...], mDraw: …}
let accuracyDone = false;   // has this stroke been graded?


function refresh () {
    if (!mainC) return;                  // called before setup? ignore
    f    = parse(fnIn.value);
    x0   = +x0In.value;
    xmin = +xminIn.value;
    xmax = +xmaxIn.value;

    /* ── NEW: recompute the very first gaps from gapInput ── */
    let frac = Number(gapIn.value) || 0.8;          // default 0.80
    frac = Math.max(0.05, Math.min(frac, 0.95));    // clamp 5-…95 %
    deltaL = Math.max((x0 - xmin) * frac, 1e-4);
    deltaR = Math.max((xmax - x0) * frac, 1e-4);
    /* ─────────────────────────────────────────────────────── */

    anim = false;                       // stop any running animation
    noLoop();
    rescale();                          // recompute sx,sy and off
    redraw();                           // show the updated view

    /* ── histogram camera reset whenever the function changes ── */
    const histMaxIn = document.getElementById('histMax');   // ← add this
    let   histSpan  =  Math.max(1, +histMaxIn.value || 1);
    let   histCenter = 0;

}


/* ------- controls ------------------------------------------------- */
const fnIn=$('fnInput'), x0In=$('x0Input'),
    xminIn=$('xmin'),  xmaxIn=$('xmax'),
    spdIn=$('speedInput'), maxIn=$('maxIt'),
    startBtn=$('startBtn'), pauseBtn=$('pauseBtn'), resetBtn=$('resetBtn'),
    list=$('exampleList'), gapIn = $('gapInput'),
    mainHold=$('main-holder'), traceHold=$('trace-holder'), histHold=$('hist-holder'), histMaxIn = $('histMax');

[fnIn,x0In,xminIn,xmaxIn,list, gapIn].forEach(el=>{
    el.addEventListener('input',   refresh);  // fires every keystroke
    el.addEventListener('change',  refresh);  // keep this too
    el.addEventListener('keyup', e=>{ if (e.key==='Enter') refresh(); });
});
list.onchange = () => {
    if (!list.value) return;
    fnIn.value = list.value;

    /* programmatically click the Reset button */
    resetBtn.click();      // clears slopes, fireworks, etc.

    /* then refresh inputs so xmin/xmax/x₀ updates take effect */
    refresh();
};


/* ------- canvases ------------------------------------------------- */
let traceC, compassC, histC;

/* ------- state ---------------------------------------------------- */
let f=x=>Math.abs(x), x0=1, xmin=-10, xmax=10,
    delta=1.3, speed=0.04, maxSteps=300,
    deltaL = 2,deltaR = 1.5,
    anim=false, paused=false, slopes=[], steps=0;

/* view (pan/zoom) */
let sx=60, sy=60, off={x:0,y:0}, moved=false,
    dragging=false, dragStart={x:0,y:0},
    oSX,oSY,oOff, auto='none';

/* compass game */
let drawing=false, curStroke=[], userLines=[];

/* fireworks */
let sparks=[], fireTimer=0, fireText='';

/* ------- helpers -------------------------------------------------- */
/* ---------------------------------------------------------------
   setUniformScale  –  keep sx === sy everywhere
   ------------------------------------------------------------- */
function setUniformScale(S) {
    sx = sy = S;
}


/* ---------------------------------------------------------------
   latex2js – now accepts   piece{ cond1:expr1; cond2:expr2; … }
   ------------------------------------------------------------- */
function latex2js(expr) {
    return expr

        /* piece{…} → nested ternaries (with negative‐branch fix) */
        .replace(/piece\s*\{([^}]+)\}/gi, (_, body) => {
            const segs = body.split(';').filter(Boolean);
            const mapped = segs.map(seg => {
                let [cond, val] = seg.split(':');
                cond = cond.trim();
                val  = val.trim();

                // if val starts with a minus‐power, turn "-x**2" → "-(x**2)"
                if (/^-\s*[A-Za-z0-9_]+\s*\*\*/.test(val)) {
                    const withoutMinus = val.replace(/^\s*-\s*/, '');
                    val = '-(' + withoutMinus + ')';
                }

                return `(${cond})?(${val})`;
            });

            // ...default 0 if nothing matches
            return mapped.join(':') + ':0';
        })

        /* fractional exponents  x^(2/3) → abs(x)**(2/3) */
        .replace(/([A-Za-z0-9_\)\]]+)\s*\^\s*\(\s*([0-9]+)\/([0-9]+)\s*\)/g,
            'abs($1)**($2/$3)')

        /* constants & ln() */
        .replace(/\bpi\b|π/gi, 'PI')
        .replace(/\be\b(?![a-z])/gi, 'E')
        .replace(/\bln\s*\(/gi, 'log(')

        /* all other ^ → ** */
        .replace(/\^/g, '**');
}



const parse = s => {
    try {
        const js = latex2js(s);                          // ≤── NEW
        return new Function('x', `with(Math){return ${js};}`);
    } catch {
        return () => NaN;
    }
};
function rescale () {
    /* horizontal scalar that fits the x–range */
    const sxTry = mainC.width / (xmax - xmin);

    /* vertical scalar that fits the tallest |y| we sample */
    let m = 0;
    for (let i = 0; i < 350; i++) {
        const x = xmin + i * (xmax - xmin) / 349,
            y = f(x);
        if (isFinite(y)) m = Math.max(m, Math.abs(y));
    }
    const syTry = (mainC.height * 0.45) / (m || 1);

    /* choose the tighter fit so nothing clips */
    setUniformScale(Math.min(sxTry, syTry));

    off = { x: 0, y: 0 };
}


const W2S = (x,y)=>({
    x: x*sx + mainC.width /2 + off.x,
    y: -y*sy + mainC.height/2 + off.y
});


/* ---------------------------------------------------------------
   keepPointVisible – keep *both* secant ends on–screen
   (horizontal) and still keep the red point visible (vertical)
   ------------------------------------------------------------- */
function keepPointVisible(pad = PAD) {

    /* ---- horizontal guard : secant ends ---------------------- */
    const PLx = W2S(x0 - deltaL, 0).x;          // left end of secant
    const PRx = W2S(x0 + deltaR, 0).x;          // right end of secant

    if (PLx < pad)               off.x += pad - PLx;
    else if (PRx > width - pad)  off.x -= PRx - (width - pad);

    /* ---- vertical guard : the anchor point ------------------- */
    const Py = W2S(0, f(x0)).y;                 // y-coordinate of (x₀,f(x₀))
    if (Py < pad)               off.y += pad - Py;
    else if (Py > height - pad) off.y -= Py - (height - pad);
}


function beginZoom () {
    oSX = sx; oSY = sy; oOff = {...off};
    auto = 'in'; moved = false;
}
const TAU = Math.PI * 2;
/* fireworks helpers */
/* ---------- fireworks helpers  (simple & bullet-proof) ---------- */
function burst (err) {

    fireTimer = 240;                          // fireworks keep working
    fireText  = `accuracy ${err.toFixed(2)} %`;
    sparks = [];
    for (let i = 0; i < 60; i++) {                     // 60 sparks
        const a = Math.random() * TAU,                   // TAU = 2π
            v = Math.random() * 3 + 2;                 // speed 2…5
        sparks.push({
            x : width  / 2,
            y : 80,
            vx: v * Math.cos(a),
            vy: v * Math.sin(a) - 2,
            col:`hsl(${Math.random()*360},90%,60%)`
        });
    }
}

/* draw the banner + sparks every frame */
/* -------------------------------------------------------------
 *  drawFire  –  banner + sparks
 * -----------------------------------------------------------*/
function drawFire () {
    if (fireTimer <= 0) return;          // nothing to draw
    fireTimer--;                         // countdown every frame

    /* --- draw on the main canvas ---------------------------------- */
    push(); noStroke();

    /* 1 · dark translucent bar so text is always readable */
    fill(0, 180);                        // semi-transparent black
    rect(0, 0, width, 140);              // top strip

    /* 2 · sparks animation */
    for (const s of sparks) {
        s.x += s.vx;
        s.y += s.vy;
        s.vy += 0.05;                      // gentle gravity
        fill(s.col);
        circle(s.x, s.y, 6);               // larger dots (6 px)
    }

    /* 3 · BIG, bright banner text */
    textAlign(CENTER);
    textSize(80);                        // huge font
    fill('#fffb');                       // almost-white
    text(fireText, width / 2, 95);       // centred in the bar

    pop();
}



/* ------- p5 setup ------------------------------------------------- */
function setup () {
    mainC = createCanvas(830,830);  mainC.parent(mainHold);

    traceC = createGraphics(400,400);
    traceC.canvas.style.cssText='border:2px solid #30363d;margin-left:1rem';
    traceHold.appendChild(traceC.canvas);

    compassC = createGraphics(400,400);
    compassC.canvas.style.cssText =
        'border:2px solid #30363d;margin-left:1rem';   // ← no top margin
    traceHold.appendChild(compassC.canvas);

    /* compass drawing handlers */
    const cc = compassC.canvas;
    cc.style.cursor='crosshair';
    cc.addEventListener('mousedown',e=>{
        if(e.button) return;
        drawing=true; curStroke=[[e.offsetX,e.offsetY]]; noLoop();
    });
    cc.addEventListener('mousemove',e=>{
        if(drawing) curStroke.push([e.offsetX,e.offsetY]);
    });
    cc.addEventListener('mouseup', () => {
        if (!drawing) { loop(); return; }
        drawing = false;

        if (curStroke.length < 4) {   // need ≥ 4 points for a regression
            curStroke = [];
            loop();
            return;
        }

        /* -------- linear regression  of the drawn stroke ---------- */
        let sx = 0, sy = 0, sxx = 0, sxy = 0, n = curStroke.length;
        curStroke.forEach(([x, y]) => {
            sx  += x;
            sy  += y;
            sxx += x * x;
            sxy += x * y;
        });
        const x̄ = sx / n,
            ȳ = sy / n;
        const mScr = (sxy - n * x̄ * ȳ) / (sxx - n * x̄ * x̄ || 1e-9); // screen-slope
        const mDraw = -mScr;                                           // flip y-axis

        /* true slope (left or right) at last animation sample */
        const [mL, mR] = slopes.length ? slopes.at(-1) : [NaN, NaN];
        const mTrue    = mDraw < 0 ? mL : mR;

        /* angle-based accuracy ------------------------------------- */
        const toDeg = m => Math.atan(m) * 180 / Math.PI;
        let diff = Math.abs(toDeg(mDraw) - toDeg(mTrue));   // 0…180 °
        if (diff > 90) diff = 180 - diff;                   // minimal angle
        const acc = isFinite(diff) ? 100 - (diff / 90) * 100 : NaN; // 100 % perfect

        /* store the stroke; only keep the very last one ------------- */
        userLines.splice(0, userLines.length);   // drop previous lines
        userLines.push({ pts: [...curStroke], err: acc });

        if (isFinite(acc)) burst(acc);           // fireworks + banner


        /* ---- store stroke for later grading ---- */
        latestStroke = {          // keep the points and the slope you drew
            pts  : [...curStroke],
            mDraw                         // ← already computed above
        };
        accuracyDone = false;           // we still need to grade it

        curStroke  = [];                // clear live stroke
        loop();                         // resume animation frames


    });


    histC = createGraphics(1240,300);
    histC.canvas.style.cssText='border:2px solid #30363d;margin-top:1rem';
    histC.colorMode(histC.HSB,360,100,100);
    histHold.appendChild(histC.canvas);

    pixelDensity(1);                       // no Hi-DPI → fewer pixels to push

    /* pause the loop while the tab is hidden */
    document.addEventListener('visibilitychange', () =>
        document.hidden ? noLoop() : loop()
    );


    frameRate(60);
    rescale();

    /* run once so globals match the inputs on first load */
    refresh();

}


/* ───────────────────────────────────────────────────────────
 * Pause the p5 draw-loop whenever the page (or the window)
 * loses focus; resume when it’s visible again.
 * Works in every browser.
 * ─────────────────────────────────────────────────────────*/
function handleVisibility () {
    /* hidden OR background window? → stop the loop */
    if (document.visibilityState === 'hidden' || document.hidden) {
        noLoop();                       // p5 stops requesting frames
    } else {
        loop();                         // resume normal draw()
    }
}

/* fire on all relevant signals */
document.addEventListener('visibilitychange', handleVisibility, false);
window.addEventListener('blur',              handleVisibility, false);
window.addEventListener('focus',             handleVisibility, false);



/* ------- main draw loop ------------------------------------------ */
function draw () {
    /* throttle FPS: full speed only when something moves */
    /* full-speed whenever: animation is running, you’re sketching,
   the auto-zoom routine is active, or the mouse is panning */
    const ACTIVE =
        (anim && !paused)      // secant animation
        || drawing                // purple free-hand stroke
        || auto !== 'none'        // auto-zoom in/out phase
        || dragging;              // mouse-pan in progress

    frameRate(ACTIVE ? ACTIVE_FPS : IDLE_FPS);




    background('#0d1117');
    drawMain(); drawTrace(); drawCompass(); drawHist();
    drawFire();
}


/* ----------  domain-safety helpers  ---------- */
function safeY(x){                       // null if f(x) is bad
    const y = f(x);
    return Number.isFinite(y) ? y : null;
}

function shrinkUntilOK(side){            // side = 'L' | 'R'
    const lim = 20;                        // max halvings
    for(let i=0;i<lim;i++){
        const dx = side==='L' ? deltaL : deltaR;
        const x  = side==='L' ? x0-dx : x0+dx;
        if (safeY(x) !== null) return true;
        side==='L' ? (deltaL *= 0.7) : (deltaR *= 0.7);
    }
    return false;                          // gave up
}

function randSide(side){                 // random but valid pick
    const dxBase = side==='L' ? -deltaL :  deltaR;
    const dxAbs  = side==='L' ?  deltaL :  deltaR;
    for(let i=0;i<10;i++){
        const x = x0 + dxBase + (Math.random()-0.5)*dxAbs*0.3;
        if (safeY(x) !== null) return x;
    }
    return null;                           // fallback signal
}



/* 1 · main graph --------------------------------------------------- */
/*****************************************************************
 *  drawMain()  ·  stable layout  ·  asymmetric random sampling
 *****************************************************************/
let lastLX = null, lastRX = null;   // remember points from last frame

/*****************************************************************
 *  drawMain()  ·  Δ shrinks by varying ratios, asymmetric samples
 *****************************************************************/
let lastL = null, lastR = null;            // remember visual secant pts

/*****************************************************************
 *  drawMain()  ·  monotone Δ-shrink, nested secant points
 *****************************************************************/
let visLX = null, visRX = null;         // remember last visual points

/* ──────────────────────────────────────────────────────────────
   drawMain ­– full version with *independent* left/right gaps
   Assumes the following globals already exist elsewhere:
   xmin, xmax, width, height, sx, sy, off (vec2), oSX, oSY, oOff,
   MAX_ZOOM, x0, speed, anim, paused, moved, auto,
   slopes, TRACE_MAX, steps, maxSteps,
   accuracyDone, latestStroke, userLines, burst,
   W2S( x , y ), keepPointVisible(), f( x )
----------------------------------------------------------------*/

const MIN_EDGE_TICKS = 3;      // keep at least this many numbers visible
const MAX_DECIMALS   = 6;      // allow up to 6 fractional digits

function niceStep(raw){        // 1·10ᵏ, 2·10ᵏ or 5·10ᵏ
    const k = 10 ** Math.floor(Math.log10(raw));
    return raw / k >= 5 ? 5 * k : raw / k >= 2 ? 2 * k : k;
}


function drawMain () {
    /* ── 1.  Grid ───────────────────────────────────────────── */
    stroke('#20262f'); strokeWeight(1);
    for (let xi = Math.ceil(xmin); xi <= Math.floor(xmax); xi++)
        line(W2S(xi, 0).x, 0, W2S(xi, 0).x, height);

    const ySpan = height / 2 / sy,
        yMin  = Math.floor(-off.y / sy - ySpan),
        yMax  = Math.ceil ( -off.y / sy + ySpan);
    for (let yi = yMin; yi <= yMax; yi++)
        line(0, W2S(0, yi).y, width, W2S(0, yi).y);

    /* ── 2.  Axes & ticks ───────────────────────────────────── */
    stroke('#758190'); strokeWeight(2);
    const o = W2S(0, 0);
    line(o.x, 0, o.x, height);        // y-axis
    line(0,   o.y, width, o.y);       // x-axis
    fill('#758190'); noStroke();
    triangle(width - 8, o.y, width - 16, o.y - 5, width - 16, o.y + 5);
    triangle(o.x, 8, o.x - 5, 16, o.x + 5, 16);

    fill('#9aa5b3'); noStroke(); textSize(11);
    for (let xi = Math.ceil(xmin); xi <= Math.floor(xmax); xi++)
        text(xi, W2S(xi, 0).x - 5, o.y + 15);
    for (let yi = yMin; yi <= yMax; yi++)
        if (yi) text(yi, o.x + 6, W2S(0, yi).y + 4);

    /* visible world-ranges — note the corrected Y maths  */
    const xL = (-width / 2  - off.x) / sx,
        xR = ( width / 2  - off.x) / sx,
        yB = (-height / 2 + off.y) / sy,   // ← sign fixed
        yT = ( height / 2 + off.y) / sy;

    /* helper that picks a “nice” step AND avoids label overlap */
    function chooseStep(span, pixelScale){
        let step = niceStep(span / 8);                 // start guess
        while (span / step < MIN_EDGE_TICKS) step /= 2;/* guarantee ≥3 */

        /* widen spacing if label would collide (wider for more decimals) */
        for (;;){
            const pxGap = step * pixelScale;
            let dec = Math.min(MAX_DECIMALS,
                Math.max(0, Math.ceil(-Math.log10(step))));
            const minPx = 50 + dec * 8;                // heuristic width
            if (pxGap >= minPx) return {step, dec};
            step *= 2;                                 // make gap wider
        }
    }

    const {step: dx, dec: px} = chooseStep(xR - xL, sx);
    const {step: dy, dec: py} = chooseStep(yT - yB, sy);

    stroke('#758190'); strokeWeight(1);
    fill('#9aa5b3');    textSize(10);

    /* ---- X edge (bottom) ---- */
    for (let x = Math.ceil(xL / dx) * dx; x <= xR; x += dx) {
        const u = W2S(x, 0).x;
        line(u, height - 8, u, height);
        text(x.toFixed(px), u - 8, height - 10);
    }

    /* ---- Y edge (left) ------ */
    for (let y = Math.ceil(yB / dy) * dy; y <= yT; y += dy) {
        const v = W2S(0, y).y;
        line(0, v, 8, v);
        text(y.toFixed(py), 10, v + 4);
    }

    /* ── 3.  Function curve ─────────────────────────────────── */
    stroke('#477049'); strokeWeight(3); noFill(); beginShape();
    for (let px = 0; px <= width; px++) {
        const x = (px - width / 2 - off.x) / sx,
            y = f(x);
        if (isFinite(y)) vertex(W2S(x, y).x, W2S(x, y).y);
    }
    endShape();

    /* ── 4.  Secant (visual) ────────────────────────────────── */
    const lxVis = x0 - deltaL,
        rxVis = x0 + deltaR,
        y0    = f(x0);

    const yLvis = safeY(lxVis) ?? y0;
    const yRvis = safeY(rxVis) ?? y0;


    const P0 = W2S(x0,  y0),
        PL = W2S(lxVis, yLvis),
        PR = W2S(rxVis, yRvis);

    stroke('#ffa657'); strokeWeight(4); line(PL.x, PL.y, P0.x, P0.y);
    stroke('#64dcff');                   line(P0.x, P0.y, PR.x, PR.y);
    fill('#ff6347'); noStroke(); circle(P0.x, P0.y, 10);

    /* ── 5.  Animation step ─────────────────────────────────── */
    if (anim && !paused) {

        /* asymmetric random samples each frame */
        const lxRand = randSide('L') ?? x0;   // fallback to x₀ if null
        const rxRand = randSide('R') ?? x0;

        const yL = f(lxRand),
            yR = f(rxRand);

        slopes.push([
            (y0 - yL) / (x0   - lxRand),   // left slope
            (yR - y0) / (rxRand - x0)      // right slope
        ]);
        if (slopes.length > TRACE_MAX) slopes.shift();

        if (++steps >= maxSteps) anim = false;

        // independently shrink gaps
        const base = 1 - speed;           // < 1, e.g. 0.96
        const rand = () => 0.98 + 0.02 * Math.random(); // 0.95 … 1.00
        deltaL *= base * rand();
        deltaR *= base * rand();



        if (deltaL < 1e-12 && deltaR < 1e-12) anim = false;
    }

    /* ── 6.  Auto-zoom ──────────────────────────────────────── */
    if (!moved) {
        /* ------------------------------------------------------------------
    Auto-zoom-in block  (replace the old block verbatim)
    ------------------------------------------------------------------*/
        if (auto === 'in') {

            /* 1 ─ horizontal target scale: leave X_PAD_FRAC on each side */
            const tSX = (width * (0.6 - 2 * X_PAD_FRAC)) / (deltaL + deltaR);

            /* 2 ─ vertical target scale: span full y-range + top/bottom pad */
            const yLow  = Math.min(y0, yLvis, yRvis);
            const yHigh = Math.max(y0, yLvis, yRvis);
            const halfRange = (yHigh - yLow) / 2 || 1e-9;
            const tSY = (height * (0.45 - 2 * Y_PAD_FRAC)) /
                ((yHigh - yLow) / 2 || 1e-9);

            /* 2 ─ pick the tighter one and apply it uniformly */
            const tS = Math.min(tSX, tSY);
            setUniformScale(lerp(sx, Math.min(tS, oSX * MAX_ZOOM), 0.1));

            /* 3 ─ ease existing scales toward the targets (capped) */
            sx = lerp(sx, Math.min(tSX, oSX * MAX_ZOOM), 0.1);
            sy = lerp(sy, Math.min(tSY, oSY * MAX_ZOOM), 0.1);

            /* 4 ─ horizontal centring: secant midpoint */
            const centreX = x0 + (deltaR - deltaL) / 2;
            off.x = lerp(off.x, -centreX * sx, 0.1);

            /* 5 ─ vertical centring: midpoint plus upper pad */
            const yMid = (yHigh + yLow) / 2;
            off.y = lerp(
                off.y,
                (yMid + (yHigh - yLow) * Y_PAD_FRAC) * sy,
                0.1
            );

            keepPointVisible();          // keep both ends in frame
            if (!anim) auto = 'out';
        }
        else if (auto === 'out') {
            sx   = lerp(sx,  oSX, 0.05);
            sy   = lerp(sy,  oSY, 0.05);
            off.x = lerp(off.x, oOff.x, 0.05);
            off.y = lerp(off.y, oOff.y, 0.05);
            keepPointVisible();
            if (Math.abs(sx - oSX) < 0.3) auto = 'none';
        }
    }

    /* ── 7.  Grade free-hand once animation stops ───────────── */
    if (!anim && !accuracyDone && latestStroke && slopes.length) {
        const { mDraw, pts } = latestStroke;
        const [mL, mR] = slopes.at(-1);
        const mTrue    = 0.5 * (mL + mR);

        const toDeg = m => Math.atan(m) * 180 / Math.PI;
        let diff = Math.abs(toDeg(mDraw) - toDeg(mTrue));
        if (diff > 90) diff = 180 - diff;
        const acc = 100 - (diff / 90) * 100;

        burst(acc);
        userLines.length = 0;
        userLines.push({ pts, err: acc });
        accuracyDone  = true;
        latestStroke  = null;
    }

    /* ── ΔL / ΔR read-out ─────────────────────────────────────── */
    {
        const fmt = v => Math.abs(v) < 1e-7
            ? v.toExponential(1)
            : +v.toFixed(9).replace(/\.?0+$/, '');

        textAlign(CENTER); textSize(16);
        fill('#ffa657'); text(`ΔL = ${fmt(deltaL)}`, width/2 - 100, height - 28);
        fill('#64dcff'); text(`ΔR = ${fmt(deltaR)}`, width/2 + 100, height - 28);
    }

    /* ── rounded border ─────────────────────────────────────── */
    push();
    noFill();
    stroke('#9a3838');          // same red you used before
    strokeWeight(2);
    rect(0, 0, width, height, 8);   // 8 px corner-radius
    pop();


}







/* ──────────────────────────────────────────────────────────────
 *  2 · slope trace  — now with x- and y-ticks
 * ────────────────────────────────────────────────────────────*/
// function drawTrace () {
//     traceC.background('#161b22');
//
//     /* centre lines */
//     const cx = traceC.width  / 2,
//         cy = traceC.height / 2;
//
//     traceC.stroke('#2f3a46');
//     traceC.line(cx, 20, cx, traceC.height - 20);      // vertical mid
//     traceC.line(50, cy, traceC.width - 10, cy);       // horizontal mid
//
//     /* no data yet */
//     if (!slopes.length) {
//         traceC.fill('#e6edf3');
//         traceC.textAlign(traceC.CENTER, traceC.CENTER);
//         traceC.textSize(14);
//         traceC.text('press Animate', cx, cy);
//         return;
//     }
//
//     /* basic scaling */
//     const N     = Math.min(slopes.length, TRACE_MAX),
//         start = slopes.length - N,
//         xs    = (traceC.width - 60) / (N - 1 || 1),
//         maxA  = Math.max(...slopes.slice(start).flat().map(Math.abs)) || 1,
//         ys    = (traceC.height / 2 - 60) / maxA;
//
//     /* L- and R-slope traces */
//     [['#ffa657', 0], ['#64dcff', 1]].forEach(([col, i]) => {
//         traceC.noFill();
//         traceC.stroke(col);
//         traceC.strokeWeight(2);
//         traceC.beginShape();
//         for (let k = 0; k < N; k++)
//             traceC.vertex(50 + k * xs, cy - slopes[start + k][i] * ys);
//         traceC.endShape();
//     });
//
//     /* ─── dynamic ticks & labels ────────────────────────── */
//     traceC.stroke('#3d4856');
//     traceC.fill('#9aa5b3');
//     traceC.textSize(10);
//
//     /* y-axis ticks (slope values) */
//     const yDivs  = 2,                       // ±2 -> 5 ticks total
//         yStep  = maxA / yDivs,
//         yPix   = (traceC.height / 2 - 60) / maxA;
//     for (let i = -yDivs; i <= yDivs; i++) {
//         const v = cy - i * yStep * yPix;
//         traceC.line(46, v, 50, v);
//         traceC.text((i * yStep).toFixed(2), 15, v + 3);
//     }
//
//     /* x-axis ticks (step number) */
//     const xTickGap = Math.max(1, Math.round(N / 6)),     // ~6 ticks
//         firstLab = Math.ceil(start / xTickGap) * xTickGap;
//     for (let s = firstLab; s < slopes.length; s += xTickGap) {
//         const u = 50 + (s - start) * xs;
//         traceC.line(u, cy + 2, u, cy - 2);
//         traceC.text(s, u - 8, cy + 16);
//     }
//
//     /* current-value read-out */
//     const [mL, mR] = slopes.at(-1);
//     traceC.fill('#e6edf3');
//     traceC.noStroke();
//     traceC.textSize(18);
//     traceC.textAlign(traceC.LEFT);
//     traceC.text(`mL=${mL.toFixed(4)}`, 14, 26);
//     traceC.text(`mR=${mR.toFixed(4)}`, 14, 50);
//     traceC.textSize(14);
//     traceC.text(`step=${steps}`, 14, 74);
// }

function drawTrace () {
    traceC.background('#161b22');

    /* centre lines */
    const cx = traceC.width / 2,
        cy = traceC.height / 2;
    traceC.stroke('#2f3a46');
    traceC.line(cx, 22, cx, traceC.height - 20);       // vertical mid
    traceC.line(50, cy, traceC.width - 10, cy);        // horizontal mid

    /* no data yet */
    if (!slopes.length) {
        traceC.fill('#e6edf3');
        traceC.textAlign(traceC.CENTER, traceC.CENTER);
        traceC.textSize(14);
        traceC.text('press Animate', cx, cy);
        return;
    }

    /* basic scaling */
    const N     = Math.min(slopes.length, TRACE_MAX),
        start = slopes.length - N,
        xs    = (traceC.width - 60) / (N - 1 || 1),
        maxA  = Math.max(...slopes.slice(start).flat().map(Math.abs)) || 1,
        ys    = (traceC.height / 2 - 60) / maxA;

    /* L- and R-slope traces */
    [['#ffa657', 0], ['#64dcff', 1]].forEach(([col, i]) => {
        traceC.noFill();
        traceC.stroke(col);
        traceC.strokeWeight(2);
        traceC.beginShape();
        for (let k = 0; k < N; k++)
            traceC.vertex(50 + k * xs, cy - slopes[start + k][i] * ys);
        traceC.endShape();
    });

    /* ─── dynamic ticks & labels ─────────────────────── */
    traceC.stroke('#3d4856');
    traceC.fill('#9aa5b3');
    traceC.textSize(10);

    /* y-axis ticks */
    const yDivs = 2,
        yStep = maxA / yDivs,
        yPix  = (traceC.height / 2 - 60) / maxA;
    for (let i = -yDivs; i <= yDivs; i++) {
        const v = cy - i * yStep * yPix;
        traceC.line(46, v, 50, v);
        traceC.text((i * yStep).toFixed(2), 15, v + 3);
    }

    /* x-axis ticks */
    const xTickGap = Math.max(1, Math.round(N / 6)),
        firstLab = Math.ceil(start / xTickGap) * xTickGap;
    for (let s = firstLab; s < slopes.length; s += xTickGap) {
        const u = 50 + (s - start) * xs;
        traceC.line(u, cy + 2, u, cy - 2);
        traceC.text(s, u - 8, cy + 16);
    }

    /* ─── slope read-out in a translucent box ─────────── */
    const [mL, mR] = slopes.at(-1),
        boxW = 150, boxH = 48,
        boxX = traceC.width - boxW - 10,
        boxY = traceC.height - boxH - 10;

    traceC.noStroke();
    traceC.fill(0, 180);               // black, 70 % opacity
    traceC.rect(boxX, boxY, boxW, boxH, 6);

    traceC.textAlign(traceC.LEFT, traceC.CENTER);
    traceC.textSize(16);
    traceC.fill('#ffa657');
    traceC.text(`slopeL = ${mL.toFixed(4)}`, boxX + 10, boxY + boxH / 3);
    traceC.fill('#64dcff');
    traceC.text(`slopeR = ${mR.toFixed(4)}`, boxX + 10, boxY + 2 * boxH / 3);

    /* ── title ───────────────────────────────────────── */
    traceC.fill('#e6edf3');
    traceC.textAlign(traceC.CENTER, traceC.TOP);
    traceC.textSize(14);
    traceC.text('Slope trace', traceC.width / 2, 6);
}



/* ──────────────────────────────────────────────────────────────
 *  3 · compass  — now with 30° ticks and labels every 60°
 * ────────────────────────────────────────────────────────────*/
function drawCompass () {
    compassC.background('#161b22');

    const cx = compassC.width  / 2,
        cy = compassC.height / 2,
        R  = 160;

    /* outer ring */
    compassC.noFill();
    compassC.stroke('#30363d');
    compassC.circle(cx, cy, R * 1.1);

    /* degree ticks around the rim */
    compassC.stroke('#3d4856');
    compassC.fill('#9aa5b3');
    compassC.textSize(10);

    for (let deg = 0; deg < 360; deg += 30) {
        const a   = deg * Math.PI / 180,
            r1  = R * 1.05,
            r2  = R * 1.10,
            x1  = cx + r1 * Math.cos(a),
            y1  = cy + r1 * Math.sin(a),
            x2  = cx + r2 * Math.cos(a),
            y2  = cy + r2 * Math.sin(a);

        compassC.line(x1, y1, x2, y2);          // radial tick

        /* label every 90° to avoid clutter */
        if (deg % 90 === 0) {
            const disp = (360 - deg) % 360;          // 0, 300, 240, …
            const lx   = cx + (r2 + 12) * Math.cos(a),
                ly   = cy + (r2 + 12) * Math.sin(a);
            compassC.text(disp, lx - 4, ly + 4);
        }
    }

    /* draw latest free-hand stroke (if any) */
    if (userLines.length) {
        const u = userLines.at(-1);
        compassC.noFill();
        compassC.stroke('#c678dd');
        compassC.strokeWeight(2);
        compassC.beginShape();
        u.pts.forEach(([x, y]) => compassC.vertex(x, y));
        compassC.endShape();
    }

    /* no slopes yet? */
    if (!slopes.length) {
        compassC.fill('#e6edf3');
        compassC.textAlign(compassC.CENTER, compassC.CENTER);
        compassC.textSize(14);
        compassC.text('press Animate', cx, cy);
        return;
    }

    /* compass needles */
    const [mL, mR] = slopes.at(-1),
        needle = (s, col) => {
            const a  = Math.atan(s),
                dx = R * Math.cos(a),
                dy = R * Math.sin(a);
            compassC.stroke(col);
            compassC.strokeWeight(3);
            compassC.line(cx - dx, cy + dy, cx + dx, cy - dy);
        };

    needle(mL, '#ffa657');
    needle(mR, '#64dcff');

    /* caption */
    compassC.noStroke();
    compassC.fill('#e6edf3');
    compassC.textSize(12);
    compassC.textAlign(compassC.CENTER);
    compassC.text('Current slopes', cx, cy + R * 0.85);
}


/* 4 · histogram (unchanged) */
/* ===================================================================
 *  drawHist()  –  centred bins, zoom + pan, exact tool-tips
 * ===================================================================
 *  STEP  = “nice” 1, 2 or 5 × 10ᵏ
 *  Interior bin i (i = 0 … nInt-1) has centre
 *        centre_i = firstCentre + i·STEP
 *  and represents ( centre_i – STEP/2 , centre_i + STEP/2 ].
 *  Under- / overflow bins gather everything outside ±M.
 * -------------------------------------------------------------------*/
function drawHist () {

    /* ─── 1. One-time event wiring ─────────────────────────────── */
    if (!drawHist._wired) {
        const histMaxIn = document.getElementById('histMax');
        histMaxIn.addEventListener('input', () => {
            histSpan   = Math.max(1, +histMaxIn.value || 1);  // new ±range
            histCenter = 0;                                   // recenter
            drawHist._userZoom = false;                       // allow auto logic again
            redraw();                                         // instant update
        });
        window.histSpan = Math.max(1, +histMaxIn?.value || 1);  // start from input

        window.histCenter = 0;
        window.histTip    = {on:false,x:0,y:0,txt:'',ttl:0};

        const cvs = histC.canvas;
        let dragX = null, dragC = 0;

        /* wheel → zoom (about cursor) */
        cvs.addEventListener('wheel', e=>{
            const r=cvs.getBoundingClientRect(),
                f=(e.clientX-r.left)/r.width,
                xAt=histCenter-histSpan+f*2*histSpan,
                z=e.deltaY>0?1.1:0.9;
            histSpan   = Math.max(0.02,Math.min(500,histSpan*z));
            histCenter = xAt + histSpan*(1-2*f);
            redraw(); e.preventDefault();
        },{passive:false});

        /* drag → pan */
        cvs.addEventListener('mousedown',e=>{dragX=e.clientX; dragC=histCenter;});
        window.addEventListener('mousemove',e=>{
            if(dragX===null) return;
            const w=cvs.getBoundingClientRect().width,
                dx=(e.clientX-dragX)/w*2*histSpan;
            histCenter = dragC - dx; redraw();
        });
        window.addEventListener('mouseup',()=>dragX=null);

        /* dbl-click → reset */
        cvs.addEventListener('dblclick',()=>{histSpan=10;histCenter=0;redraw();});

        /* “+” / “–” keys → coarse zoom */
        window.addEventListener('keydown',e=>{
            if(e.key==='+'||e.key==='='){histSpan=Math.max(0.02,histSpan*0.8);redraw();}
            if(e.key==='-'){histSpan=Math.min(500,histSpan/0.8);redraw();}
        });

        /* Cmd/Ctrl-click → interval tooltip */
        cvs.addEventListener('click',e=>{
            if(!(e.metaKey||e.ctrlKey)||!drawHist._ready) return;
            const r=cvs.getBoundingClientRect(),
                xPix=e.clientX-r.left,
                idx = Math.floor(((xPix - 120) + drawHist._barW/2) / drawHist._barW);   // one index per bar
            if(idx<=0||idx>=drawHist._nBins-1) return;          // ignore under/over

            const centre = drawHist._first + (idx-1)*drawHist._STEP, // idx-1 skips underflow
                a = +(centre - drawHist._STEP/2).toFixed(drawHist._PREC),
                b = +(centre + drawHist._STEP/2).toFixed(drawHist._PREC),
                n = drawHist._binsL[idx] + drawHist._binsR[idx];

            histTip={on:true,x:xPix,y:e.clientY-r.top,
                txt:`(${a}, ${b}]  →  ${n}`,ttl:140};
            redraw();
        });

        drawHist._wired = true;
    }

    /* ─── 2. Choose a “nice” bin width STEP = 1, 2, 5 × 10ᵏ ───── */
    const nice = span=>{
        const raw=span/12,p=10**Math.floor(Math.log10(raw)),m=raw/p;
        return (m<1.5?1:m<3?2:m<7.5?5:10)*p;
    };
    const STEP = nice(histSpan),
        PREC = Math.max(1, -Math.floor(Math.log10(STEP/2))); // always ≥1 dec

    /* ─── 3. Compute first & last interior centres ─────────────── */
    const leftEdge  = histCenter - histSpan,
        firstC    = Math.ceil((leftEdge-STEP/2)/STEP)*STEP,  // leftmost centre
        rightEdge = histCenter + histSpan,
        lastC     = Math.floor((rightEdge+STEP/2)/STEP)*STEP,
        nInt      = Math.round((lastC-firstC)/STEP)+1,
        nBins     = nInt + 2;                                // + under/over

    const barW = (histC.width-80)/nBins;

    // share with tooltip handler
    Object.assign(drawHist,{
        _STEP:STEP,_PREC:PREC,_first:firstC,_nBins:nBins,_barW:barW
    });

    /* ─── 4. Bin the slope data ───────────────────────────────── */
    histC.background('#161b22');
    const L=slopes.map(s=>s[0]).filter(Number.isFinite),
        R=slopes.map(s=>s[1]).filter(Number.isFinite);
    if(!L.length&&!R.length){
        histC.fill('#e6edf3'); histC.textAlign(histC.CENTER,histC.CENTER);
        histC.textSize(14); histC.text('press Animate',histC.width/2,histC.height/2);
        drawHist._ready=false; return;
    }
    drawHist._ready=true;

    const binsL=Array(nBins).fill(0), binsR=Array(nBins).fill(0);

    const put=(arr,v)=>{
        const i=Math.floor((v-(firstC-STEP/2))/STEP)+1; // +1 skips underflow slot
        if(i<0) arr[0]++; else if(i>=nBins-1) arr[nBins-1]++; else arr[i]++;
    };
    L.forEach(v=>put(binsL,v)); R.forEach(v=>put(binsR,v));

    // /* ── auto-expand until no samples land in the overflow bins ── */
    // if (!drawHist._autoscaling) {       // guard against infinite loops
    //     drawHist._autoscaling = true;     // (set flag)
    //
    //     const tooLow  = binsL[0] + binsR[0],
    //         tooHigh = binsL[nBins-1] + binsR[nBins-1];
    //
    //     if ((tooLow || tooHigh) && histSpan < 10) {
    //         histSpan *= 2;                  // widen view to ±2, ±4, ±8 …
    //         if (histSpan > 10) histSpan = 10;
    //         redraw();                       // re-run with the wider span
    //         drawHist._autoscaling = false;
    //         return;                         // stop this draw cycle here
    //     }
    //     drawHist._autoscaling = false;    // clear flag
    // }


    drawHist._binsL=binsL; drawHist._binsR=binsR;

    /* ─── 5. Draw bars, axes, labels, tooltip ─────────────────── */
    const maxC=Math.max(...binsL.map((c,i)=>c+binsR[i])),
        y0   = histC.height-62,
        yS   = (histC.height-82)/(maxC||1);

    // bars
    for(let i=0;i<nBins;i++){
        const x=80+i*barW, hL=binsL[i]*yS, hR=binsR[i]*yS;
        histC.fill('#ffa657'); histC.rect(x,y0-hL,barW-1,hL);
        histC.fill('#64dcff'); histC.rect(x,y0-hL-hR,barW-1,hR);

        // label
        let lbl;
        if(i===0)          lbl=`≤${(firstC-STEP).toFixed(PREC)}`;
        else if(i===nBins-1)lbl=`≥${(firstC+(nInt-1)*STEP+STEP).toFixed(PREC)}`;
        else                lbl=(firstC+(i-1)*STEP).toFixed(PREC);
        histC.noStroke(); histC.fill('#e6edf3'); histC.textSize(10);
        histC.textAlign(histC.CENTER);
        histC.text(lbl,x+barW/2,histC.height-48);
    }

    // y-axis
    histC.stroke('#e6edf3'); histC.line(70,20,70,y0); histC.line(70,y0,histC.width,y0);
    histC.noStroke(); histC.fill('#e6edf3'); histC.textSize(11); histC.textAlign(histC.RIGHT);
    [0,0.25,0.5,0.75,1].forEach(t=>{
        const y=y0-t*(histC.height-82);
        histC.text(Math.round(maxC*t),65,y+4);
        histC.stroke('#30363d'); histC.line(67,y,70,y); histC.noStroke();
    });

    // tooltip
    if(histTip.on){
        if(--histTip.ttl<=0) histTip.on=false;
        else{
            histC.push(); histC.translate(histTip.x,histTip.y-28);
            histC.fill(0,200); histC.noStroke(); histC.rect(-90,-18,180,26,4);
            histC.fill('#e6edf3'); histC.textSize(11);
            histC.textAlign(histC.CENTER,histC.CENTER);
            histC.text(histTip.txt,0,-5);
            histC.pop(); redraw();
        }
    }

    // title
    histC.fill('#e6edf3'); histC.textAlign(histC.CENTER,histC.BOTTOM);
    histC.textSize(14); histC.text('Slope histogram',histC.width/2,histC.height-8);
}


















/* ------- buttons & controls --------------------------------------- */
function start(){
    loop();
    f=parse(fnIn.value); x0=+x0In.value;
    /* NEW guard: stop if the function isn’t finite at x₀ */
    if (!Number.isFinite(f(x0))) {
        alert('f(x₀) is undefined or infinite at the chosen x₀. Pick another point.');
        anim = false;          // keep everything idle
        return;                // exit start()
    }
    xmin=+xminIn.value; xmax=+xmaxIn.value;
    speed=+spdIn.value; maxSteps=Math.max(1,+maxIn.value||300);
    // delta=Math.max((xmax-xmin)/4,0.001);


    /* choose the user-supplied fraction of the room and verify domain */
    let frac = Number(gapIn.value) || 0.8;        // fallback to 0.8
    frac = Math.max(0.05, Math.min(frac, 0.95));  // clamp to 5 % … 95 %

    deltaL = Math.max((x0 - xmin) * frac, 1e-4);
    deltaR = Math.max((xmax - x0) * frac, 1e-4);


    if (!shrinkUntilOK('L') || !shrinkUntilOK('R')) {
        anim = false;
        alert('x₀ is too close to a singularity or outside the domain.');
        return;
    }



    slopes.length=0; steps=0; sparks=[]; fireTimer=0;  // keep userLines
    anim=true; paused=false; pauseBtn.textContent='Pause';
    rescale(); beginZoom(); keepPointVisible();
}
startBtn.onclick=start;

pauseBtn.onclick=()=>{ if(!anim) return;
    paused=!paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    (paused ? noLoop() : loop());
};

/* ------- RESET button ---------------------------------------- */
resetBtn.onclick = () => {
    /* 1 · read current inputs ---------------------------------- */
    f    = parse(fnIn.value);
    x0   = +x0In.value;

    xmin = +xminIn.value;
    xmax = +xmaxIn.value;

    /* 2 · stop everything and clear logs ----------------------- */
    anim = false;
    paused = false;
    pauseBtn.textContent = 'Pause';

    slopes.length = 0;
    steps = 0;
    userLines.length = 0;
    sparks.length = 0;
    fireTimer = 0;

    curStroke.length = 0;
    drawing = false;
    accuracyDone = false;
    latestStroke = null;

    /* 3 · recompute the *initial gaps* from the gapInput -------- */
    let frac = Number(gapIn.value) || 0.8;         // default 0.80
    frac = Math.max(0.05, Math.min(frac, 0.95));   // clamp 5 %–95 %
    deltaL = Math.max((x0 - xmin) * frac, 1e-4);
    deltaR = Math.max((xmax - x0) * frac, 1e-4);

    /* 4 · reset view & modes ----------------------------------- */
    off = { x: 0, y: 0 };
    moved = false;
    auto  = 'none';

    /* ── reset the histogram camera ───────────────────────────── */
    histSpan   = Math.max(1, +histMaxIn.value || 1);
    histCenter = 0;    // keep bar 0 in the middle

    rescale();               // recompute sx, sy, off
    noLoop();
    redraw();                // one fresh frame
};



/* wheel zoom + guard ----------------------------------------------- */
window.addEventListener('wheel',e=>{
    if(e.target!==mainC.canvas) return;
    const z=e.deltaY>0?0.8:1.25,
        mx=e.offsetX-mainC.width/2-off.x,
        my=e.offsetY-mainC.height/2-off.y;
    /* uniform scaling */
    setUniformScale(Math.max(1e-3, sx * z));
    sx*=z; sy=Math.max(1e-3, sy*z);
    off.x=off.x*z + mx*(z-1);
    off.y=off.y*z + my*(z-1);
    keepPointVisible();
    moved=true;
    e.preventDefault();
},{passive:false});

/* mouse-pan --------------------------------------------------------- */
window.addEventListener('mousedown',e=>{
    if(drawing) return;
    if(e.target===mainC.canvas){
        dragging=true; dragStart={x:e.clientX-off.x, y:e.clientY-off.y};
    }
});
window.addEventListener('mousemove',e=>{
    if(drawing) return;
    if(dragging){
        off.x = e.clientX - dragStart.x;
        off.y = e.clientY - dragStart.y;
        moved = true;
    }
});
window.addEventListener('mouseup',()=>{ dragging=false });
