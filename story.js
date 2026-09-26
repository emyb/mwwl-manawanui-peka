// Story mode: plays the page like a Wrapped story. Each slide's heading pops in, then the page rolls
// smoothly through the photos, the minute book opens and turns its own pages, and it stops at the video.
// Anyone can pause, skip, change the speed, or choose to scroll themselves at any time.
//
//   ?play       start playing straight away
//   ?play=loop  play, then start again from the top (for a screen at an event)
(function () {
    'use strict';
    var root = document.querySelector('[data-hook="stage"]');
    var main = document.getElementById('main');
    if (!root || !main || !window.requestAnimationFrame || !window.Promise) return;

    var html = document.documentElement;
    var slides = Array.prototype.filter.call(main.children, function (el) {
        return el.tagName === 'SECTION';
    });
    if (slides.length < 2) return;
    var last = slides.length - 1;

    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var params;
    try { params = new URLSearchParams(location.search); } catch (err) { params = {has: function () { return false; }, get: function () { return null; }}; }
    var forcePlay = params.has('play');
    var loop = params.get('play') === 'loop';

    var lb = document.getElementById('lightbox');
    var bookBtn = document.querySelector('.zoom-btn:not(.poster-zoom)');
    var bookIndex = bookBtn ? slides.indexOf(bookBtn.closest('section')) : -1;
    var heroInner = root.querySelector('[data-hook="heroInner"]');
    var video = document.getElementById('closing-video');
    var nav = document.getElementById('slide-nav');

    // Timings (ms, at 1x). Each slide gets a time budget from how much there is to read and look at,
    // capped so no slide drags: tighter on desktop, where more fits on screen.
    var COUNTDOWN = 4500;  // hero wait before playing on its own
    var HERO = 1600;       // time on the hero once playing
    var HEAD = 1300;       // time on a heading before the page starts rolling
    var TAIL = 900;        // pause at the bottom of a slide before moving on
    var END = 2400;        // time on the video before the story ends
    var capFor = function () { return window.innerWidth < 700 ? 13000 : 8000; };
    var budgetFor = function (w, photos) { return clamp(1200 + w * 100 + photos * 450, 2600, capFor()); };
    var MAX_ROLL_SPEED = 420; // px per second, so photos never blur past
    var SPEEDS = [1, 1.5, 2];

    var speed = 1;
    try {
        var saved = parseFloat(localStorage.getItem('sm-speed'));
        if (SPEEDS.indexOf(saved) >= 0) speed = saved;
    } catch (err) { /* storage unavailable */ }

    var ICON = {
        play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
        pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>',
        prev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 5h2.2v14H5zM19 6.2v11.6a1 1 0 0 1-1.55.83L9.8 13.2a1.4 1.4 0 0 1 0-2.4l7.65-5.43A1 1 0 0 1 19 6.2z"/></svg>',
        next: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.8 5H19v14h-2.2zM5 6.2v11.6a1 1 0 0 0 1.55.83l7.65-5.43a1.4 1.4 0 0 0 0-2.4L6.55 5.37A1 1 0 0 0 5 6.2z"/></svg>',
        replay: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4.6h4.6"/></svg>'
    };

    var make = function (tag, cls, inner) {
        var el = document.createElement(tag);
        if (cls) el.className = cls;
        if (inner) el.innerHTML = inner;
        return el;
    };
    var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };

    // ---- UI ----------------------------------------------------------------------------------

    // Hero: play the story (starts on its own after a short countdown) or scroll yourself
    var choice = make('div', 'sm-choice',
        '<button type="button" class="sm-play-btn"><span class="sm-ring">' +
        '<svg class="sm-ring-track" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18"/></svg>' +
        ICON.play + '</span><span>Play the story</span></button>' +
        '<button type="button" class="sm-self-btn">I’ll scroll myself</button>' +
        '<p class="sm-hint" aria-live="polite"></p>');
    choice.style.setProperty('--sm-count', COUNTDOWN + 'ms');
    var hint = choice.querySelector('.sm-hint');
    if (heroInner) {
        var cue = heroInner.lastElementChild; // the old "Scroll" cue: the choice replaces it
        if (cue && cue.querySelector('.cue-arrow')) cue.style.display = 'none';
        heroInner.appendChild(choice);
    }

    // Progress segments, one per slide
    var bar = make('div', 'sm-bar');
    bar.setAttribute('aria-hidden', 'true');
    var segs = slides.map(function () {
        var i = make('i');
        var b = make('b');
        i.appendChild(b);
        bar.appendChild(i);
        return b;
    });

    // Player controls
    var dock = make('div', 'sm-dock',
        '<button type="button" class="sm-prev sm-x" data-show="playing paused" aria-label="Previous">' + ICON.prev + '</button>' +
        '<button type="button" class="sm-pp sm-pause" data-show="playing" aria-label="Pause">' + ICON.pause + '</button>' +
        '<button type="button" class="sm-pp sm-resume" data-show="paused" aria-label="Play">' + ICON.play + '</button>' +
        '<button type="button" class="sm-pp sm-replay" data-show="ended" aria-label="Play again from the start">' + ICON.replay + '</button>' +
        '<button type="button" class="sm-next sm-x" data-show="playing paused" aria-label="Next">' + ICON.next + '</button>' +
        '<button type="button" class="sm-speed sm-x" data-show="playing paused"></button>' +
        '<span class="sm-sep sm-x" aria-hidden="true"></span>' +
        '<button type="button" class="sm-stop sm-x">Scroll myself</button>');
    dock.setAttribute('role', 'group');
    dock.setAttribute('aria-label', 'Story controls');
    var stopBtn = dock.querySelector('.sm-stop');
    var speedBtn = dock.querySelector('.sm-speed');
    var showSpeed = function () {
        speedBtn.textContent = speed + '×';
        speedBtn.setAttribute('aria-label', 'Speed ' + speed + ' times. Change speed');
    };
    showSpeed();

    // A small way back in while scrolling yourself
    var mini = make('button', 'sm-mini', ICON.play + '<span>Play the story</span>');
    mini.type = 'button';

    var live = make('p', 'sr-only');
    live.setAttribute('aria-live', 'polite');

    root.appendChild(bar);
    root.appendChild(dock);
    root.appendChild(mini);
    root.appendChild(live);

    // ---- timing engine -----------------------------------------------------------------------

    var CANCEL = {};
    var gen = 0;
    var state = 'idle'; // idle | countdown | playing | paused | ended | manual
    var cur = 0;
    var slideDone = 0, slideTotal = 1; // progress through the current slide, in 1x ms
    var pageTop = function (el) { return el.getBoundingClientRect().top + window.scrollY; };
    var maxScroll = function () { return Math.max(0, html.scrollHeight - window.innerHeight); };
    var alive = function (g) { if (g !== gen) throw CANCEL; };

    var lastT = 0;
    var frame = function () {
        return new Promise(function (resolve) {
            requestAnimationFrame(function (t) {
                var dt = lastT ? Math.min(100, t - lastT) : 16;
                lastT = t;
                // the bar holds still while the book is open
                if (state === 'playing' && !(lb && lb.open)) {
                    slideDone += dt * speed;
                    paintBar();
                }
                resolve(dt);
            });
        });
    };

    // Run for `ms` (at 1x), honouring the speed setting as it changes, calling each(p) with 0..1
    var run = function (ms, g, each, until, rate) {
        if (ms <= 0) {
            if (each) each(1);
            return Promise.resolve();
        }
        var p = 0;
        var step = function () {
            return frame().then(function (dt) {
                alive(g);
                p = Math.min(1, p + dt * (rate ? rate() : speed) / ms);
                if (each) each(p);
                if (p >= 1 || (until && until())) return;
                return step();
            });
        };
        return step();
    };

    var wait = function (ms, g, until) { return run(ms, g, null, until); };

    var ease = function (p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };

    // A steady roll: eases in, holds a constant pace, eases out
    var RAMP = 0.12;
    var steady = function (p) {
        var v = 1 / (1 - RAMP);
        if (p < RAMP) return v * p * p / (2 * RAMP);
        if (p > 1 - RAMP) return 1 - v * (1 - p) * (1 - p) / (2 * RAMP);
        return v * (p - RAMP / 2);
    };

    // A quick move between slides
    var glide = function (to, g) {
        to = clamp(Math.round(to), 0, maxScroll());
        var from = window.scrollY, d = to - from;
        if (Math.abs(d) < 2) return Promise.resolve();
        if (reduced) {
            window.scrollTo(0, to);
            return Promise.resolve();
        }
        var dur = clamp(650 + Math.abs(d) * 0.3, 800, 1600);
        return run(dur, g, function (p) {
            window.scrollTo(0, from + d * ease(p));
            revealAhead();
        }, null, function () { return Math.sqrt(speed); });
    };

    // A slow roll down through a slide's photos
    var roll = function (to, ms, g) {
        to = clamp(Math.round(to), 0, maxScroll());
        var from = window.scrollY, d = to - from;
        if (Math.abs(d) < 2) return Promise.resolve();
        ms = Math.max(ms, Math.abs(d) / MAX_ROLL_SPEED * 1000);
        if (reduced) {
            // no rolling for reduced motion: wait, then move
            return wait(ms, g).then(function () { window.scrollTo(0, to); });
        }
        return run(ms, g, function (p) {
            window.scrollTo(0, from + d * steady(p));
            revealAhead();
        });
    };

    // ---- reading the page --------------------------------------------------------------------

    var words = function (el) {
        var m = (el.textContent || '').trim().match(/\S+/g);
        return m ? m.length : 0;
    };

    var isBook = function (el) {
        return !!(bookBtn && el.querySelector && el.querySelector('.zoom-btn:not(.poster-zoom)'));
    };

    // The things to look at in a slide: photos and blocks of text, in reading order
    var blocks = function (s) {
        return Array.prototype.filter.call(s.querySelectorAll('figure, h3, p, ol, iframe'), function (el) {
            if (el.closest('header') || el.closest('.sr-only')) return false;
            if (el.tagName !== 'FIGURE' && el.closest('figure')) return false;
            if (el.tagName !== 'OL' && el.closest('ol')) return false;
            return el.offsetWidth > 0 && el.offsetHeight > 0;
        }).map(function (el) {
            var r = el.getBoundingClientRect();
            return {el: el, top: r.top + window.scrollY, bot: r.bottom + window.scrollY};
        });
    };

    // How a slide plays: where it starts and ends, how long to roll, and where the book sits
    var planOf = function (i) {
        var s = slides[i];
        var sTop = pageTop(s);
        var vh = window.innerHeight;
        var bottom = Math.max(sTop, Math.min(sTop + s.offsetHeight - vh, maxScroll()));
        var head = s.querySelector('header');
        var hh = head ? head.offsetHeight : 0;
        var bs = blocks(s);
        var w = 0, photos = 0, book = [];
        bs.forEach(function (b) {
            if (isBook(b.el)) {
                book.push(b);
                return;
            }
            w += words(b.el);
            if (b.el.tagName === 'FIGURE') photos++;
        });
        var plan = {sTop: sTop, bottom: bottom, budget: budgetFor(w, photos), fits: bottom - sTop < 40};
        plan.roll = Math.max(1500, plan.budget - HEAD - TAIL);
        plan.total = plan.fits ? plan.budget : HEAD + plan.roll + TAIL;
        if (i === bookIndex && book.length) {
            // roll only as far as the minute book: the book opening takes the place of its photos
            var top = Math.min.apply(null, book.map(function (b) { return b.top; }));
            var bot = Math.max.apply(null, book.map(function (b) { return b.bot; }));
            plan.bookY = clamp(top - hh - 24, sTop, bottom);
            plan.afterBook = clamp(bot - hh, sTop, bottom);
        }
        return plan;
    };

    // ---- effects -----------------------------------------------------------------------------

    var enter = function (i) {
        var s = slides[i];
        s.classList.remove('sm-in');
        void s.offsetWidth;
        s.classList.add('sm-in');
    };

    var rise = function (el, delay) {
        el.setAttribute('data-sm-seen', '1');
        if (reduced) return;
        el.style.transition = 'none';
        el.style.opacity = '0.001';
        el.style.transform = 'translateY(48px) scale(0.965)';
        void el.offsetWidth;
        el.style.transition = 'opacity 800ms cubic-bezier(.2,.75,.2,1) ' + delay + 'ms, transform 950ms cubic-bezier(.2,.75,.2,1) ' + delay + 'ms';
        el.style.opacity = '1';
        el.style.transform = 'none';
    };

    // As a slide arrives, its first screenful of photos and text rise in one after another
    var revealFirst = function (i) {
        if (reduced) return;
        var s = slides[i];
        var edge = pageTop(s) + window.innerHeight;
        var n = 0;
        blocks(s).forEach(function (b) {
            if (b.el.getAttribute('data-sm-seen') || b.top > edge) return;
            var r = b.el.getBoundingClientRect();
            if (r.top < window.innerHeight && r.bottom > 0) {
                b.el.setAttribute('data-sm-seen', '1'); // already on screen: leave it be
                return;
            }
            rise(b.el, 380 + n * 140);
            n++;
        });
    };

    // While rolling, anything about to come on screen rises in
    var revealAhead = function () {
        if (reduced) return;
        var s = slides[cur];
        if (!s) return;
        var line = window.innerHeight * 1.02;
        Array.prototype.forEach.call(s.querySelectorAll('figure, h3, p, ol'), function (el) {
            if (el.getAttribute('data-sm-seen') || el.closest('header')) return;
            if (el.tagName !== 'FIGURE' && el.closest('figure')) return;
            var top = el.getBoundingClientRect().top;
            if (top < line && top > window.innerHeight * 0.6) rise(el, 0);
        });
    };

    var kb = [];
    var kenBurns = function (i, ms) {
        clearKb();
        if (reduced) return;
        Array.prototype.forEach.call(slides[i].querySelectorAll('figure'), function (f) {
            f.style.setProperty('--sm-kb', (ms / speed + 1500) + 'ms');
            f.classList.add('sm-kb');
            kb.push(f);
        });
    };
    var clearKb = function () {
        kb.forEach(function (el) { el.classList.remove('sm-kb'); });
        kb = [];
    };

    var resetSeen = function () {
        Array.prototype.forEach.call(main.querySelectorAll('[data-sm-seen]'), function (el) {
            el.removeAttribute('data-sm-seen');
        });
    };

    // ---- the minute book ---------------------------------------------------------------------

    var bookDone = false;
    var closeBook = function () {
        if (lb && lb.open) lb.close();
    };

    var playBook = function (g) {
        bookDone = true;
        if (!lb || !bookBtn) return Promise.resolve();
        var next = lb.querySelector('.lb-next');
        var shut = function () { return !lb.open; };
        bookBtn.click(); // opens on the cover
        var turns = 0;
        var turn = function () {
            if (!lb.open) return;
            if (!next || next.getAttribute('aria-disabled') === 'true' || turns > 8) {
                return wait(1600, g, shut).then(closeBook);
            }
            turns++;
            next.click();
            return wait(3000, g, shut).then(turn);
        };
        return wait(1700, g, shut).then(turn);
    };

    if (lb) {
        // turning pages yourself pauses the story; closing the book just carries on
        lb.addEventListener('click', function (e) {
            if (!e.isTrusted || state !== 'playing') return;
            if (e.target.closest && e.target.closest('.lb-prev, .lb-next, .lb-slot, .lb-single')) pause();
        }, true);
    }

    // ---- the player --------------------------------------------------------------------------

    var paintBar = function () {
        segs.forEach(function (b, i) {
            var f;
            if (state === 'ended') f = 1;
            else if (i < cur) f = 1;
            else if (i > cur) f = 0;
            else f = Math.min(1, slideDone / slideTotal);
            b.style.transform = 'scaleX(' + f + ')';
        });
    };

    var say = function (t) { live.textContent = t; };

    var setState = function (s) {
        state = s;
        var on = s === 'playing' || s === 'paused' || s === 'ended';
        html.classList.toggle('sm-active', on);
        dock.setAttribute('data-state', on ? s : 'playing');
        stopBtn.textContent = s === 'ended' ? 'Close' : 'Scroll myself';
        if (s !== 'countdown') {
            choice.classList.remove('sm-counting');
            clearTimeout(countTimer);
            hint.textContent = '';
        }
        if (s === 'playing') wake(); else html.classList.remove('sm-idle');
        if (s === 'playing') say('Story playing.');
        else if (s === 'paused') say('Story paused.');
        else if (s === 'ended') say('End of the story. The video is ready to play.');
        else if (s === 'manual') say('Story stopped. Scroll at your own pace.');
        paintBar();
        updateMini();
    };

    // Play one slide. `mid` means pick up from wherever the reader is inside it.
    var playSlide = function (i, mid, g) {
        cur = i;
        slideDone = 0;
        if (i === 0) {
            slideTotal = HERO;
            return glide(0, g).then(function () { return wait(HERO, g); });
        }
        var p = planOf(i);
        if (i === last) {
            // the video: stop with it in full view
            slideTotal = END;
            if (!mid) {
                enter(i);
                revealFirst(i);
            }
            return glide(Math.min(p.sTop, maxScroll()), g).then(function () { return wait(END, g); });
        }
        slideTotal = p.total;
        var chain;
        if (mid) {
            // resuming part way down: count the progress already made
            var span = Math.max(1, p.bottom - p.sTop);
            slideDone = HEAD + p.roll * clamp((window.scrollY - p.sTop) / span, 0, 1);
            chain = Promise.resolve();
        } else {
            enter(i);
            revealFirst(i);
            chain = glide(p.sTop, g);
        }
        if (p.fits) {
            return chain.then(function () {
                kenBurns(i, p.budget);
                return wait(mid ? p.budget / 2 : p.budget, g);
            }).then(clearKb);
        }
        if (!mid) chain = chain.then(function () { return wait(HEAD, g); });
        var rollTo = function (to) {
            var span = Math.max(1, p.bottom - p.sTop);
            return roll(to, p.roll * Math.abs(to - window.scrollY) / span, g);
        };
        if (p.bookY != null && !bookDone && window.scrollY <= p.bookY + 40) {
            chain = chain.then(function () { return rollTo(p.bookY); })
                .then(function () { return playBook(g); })
                .then(function () {
                    // anything below the book still rolls; the book's own photos are skipped
                    if (p.bottom - p.afterBook > 40) {
                        return glide(p.afterBook, g).then(function () { return rollTo(p.bottom); });
                    }
                });
        } else {
            chain = chain.then(function () { return rollTo(p.bottom); });
        }
        return chain.then(function () { return wait(TAIL, g); });
    };

    var playFrom = function (from, mid, g) {
        var i = from;
        var next = function () {
            alive(g);
            if (i > last) return finish(g);
            return playSlide(i, i === from && mid, g).then(function () {
                i++;
                return next();
            });
        };
        return next();
    };

    var finish = function (g) {
        setState('ended');
        var box = video && video.parentElement;
        if (box && !reduced) {
            box.classList.remove('sm-glow');
            void box.offsetWidth;
            box.classList.add('sm-glow');
        }
        if (loop) {
            return new Promise(function (r) { setTimeout(r, 12000); }).then(function () {
                if (g !== gen || state !== 'ended') return;
                window.scrollTo(0, 0);
                start({i: 0, mid: false}, true);
            });
        }
    };

    var start = function (pos, fresh) {
        gen++;
        var g = gen;
        lastT = 0;
        clearKb();
        if (fresh) {
            bookDone = false;
            resetSeen();
        }
        if (bookIndex >= 0 && pos.i < bookIndex) bookDone = false;
        setState('playing');
        playFrom(pos.i, pos.mid, g).catch(function (err) {
            if (err !== CANCEL && window.console) console.error(err);
        });
    };

    // work out where the reader is, so play picks up from there
    var locate = function () {
        var y = window.scrollY, line = y + window.innerHeight * 0.35, idx = 0;
        slides.forEach(function (s, i) {
            if (pageTop(s) <= line) idx = i;
        });
        return {i: idx, mid: idx > 0 && y > pageTop(slides[idx]) + 40};
    };

    var pause = function () {
        if (state !== 'playing') return;
        gen++;
        clearKb();
        setState('paused');
    };

    var resume = function () {
        closeBook();
        start(locate());
    };

    var jump = function (i) {
        i = clamp(i, 0, last);
        if (i <= bookIndex) bookDone = false;
        closeBook();
        start({i: i, mid: false});
    };

    var back = function () {
        // restart this slide if we're into it, otherwise go to the one before
        jump(cur > 0 && window.scrollY > pageTop(slides[cur]) + 60 ? cur : cur - 1);
    };

    var stop = function () {
        gen++;
        clearKb();
        closeBook();
        setState('manual');
    };

    var playFromTop = function () {
        closeBook();
        start({i: 0, mid: false}, true);
    };

    // ---- wiring ------------------------------------------------------------------------------

    choice.querySelector('.sm-play-btn').addEventListener('click', playFromTop);
    choice.querySelector('.sm-self-btn').addEventListener('click', function () {
        stop();
        var first = slides[1];
        if (first && window.scrollY < 10) first.scrollIntoView({behavior: reduced ? 'auto' : 'smooth', block: 'start'});
    });
    dock.querySelector('.sm-pause').addEventListener('click', pause);
    dock.querySelector('.sm-resume').addEventListener('click', resume);
    dock.querySelector('.sm-replay').addEventListener('click', playFromTop);
    dock.querySelector('.sm-next').addEventListener('click', function () {
        if (cur < last) jump(cur + 1);
    });
    dock.querySelector('.sm-prev').addEventListener('click', back);
    speedBtn.addEventListener('click', function () {
        speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
        try { localStorage.setItem('sm-speed', String(speed)); } catch (err) { /* storage unavailable */ }
        showSpeed();
        say('Speed ' + speed + ' times.');
    });
    stopBtn.addEventListener('click', stop);
    mini.addEventListener('click', function () {
        resetSeen();
        start(locate());
    });

    // With a mouse, the controls fade away while playing and come back when the mouse moves
    var idleTimer = 0;
    var wake = function () {
        html.classList.remove('sm-idle');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
            if (state === 'playing') html.classList.add('sm-idle');
        }, 2500);
    };
    window.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'mouse') wake();
    }, {passive: true});

    var updateMini = function () {
        mini.classList.toggle('show', state === 'manual' && window.scrollY > window.innerHeight * 0.6);
    };
    window.addEventListener('scroll', updateMini, {passive: true});

    // The reader taking over: scrolling or tapping pauses; during the countdown it means "I'll scroll"
    var controls = '.sm-dock, .sm-choice, .sm-mini, dialog, #slide-nav';
    var takeOver = function () {
        if (state === 'countdown') setState('manual');
        else if (state === 'playing') pause();
    };
    window.addEventListener('wheel', takeOver, {passive: true});
    window.addEventListener('pointerdown', function (e) {
        if (e.target && e.target.closest && e.target.closest(controls)) return;
        takeOver();
    }, {passive: true});
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) takeOver();
    });

    window.addEventListener('keydown', function (e) {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        var t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        if (document.querySelector('dialog[open]')) {
            if (state === 'playing' && /^Arrow/.test(e.key)) pause();
            return;
        }
        if (state === 'countdown') {
            if (/^(Tab|Shift|Enter| )$/.test(e.key)) return;
            setState('manual');
            return;
        }
        if (state !== 'playing' && state !== 'paused') return;
        var k = e.key;
        var onButton = t && t.closest && t.closest('button, a');
        var handled = true;
        if (k === ' ' && !onButton) {
            if (state === 'playing') pause(); else resume();
        } else if (k === 'ArrowRight' || k === 'PageDown') {
            if (cur < last) jump(cur + 1);
        } else if (k === 'ArrowLeft' || k === 'PageUp') {
            back();
        } else if (k === 'Escape') {
            stop();
        } else {
            handled = false;
            if (/^(ArrowUp|ArrowDown|Home|End)$/.test(k)) pause();
        }
        if (handled) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // While the story is on, the slide dots jump the story rather than stopping it
    if (nav) {
        nav.addEventListener('click', function (e) {
            if (state !== 'playing' && state !== 'paused') return;
            var a = e.target.closest && e.target.closest('a');
            if (!a) return;
            var i = slides.indexOf(document.getElementById((a.getAttribute('href') || '').slice(1)));
            if (i < 0) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            jump(i);
        }, true);
    }

    // ---- start -------------------------------------------------------------------------------

    var countTimer = 0;
    var atTop = function () {
        return window.scrollY < 10 && (!location.hash || location.hash === '#slide-0');
    };

    if (forcePlay && !reduced) {
        setTimeout(function () { start({i: 0, mid: false}, true); }, 600);
    } else if (reduced) {
        // no autoplay for people who've asked for less motion; the Play button is still there
        setState('manual');
    } else {
        state = 'countdown';
        setTimeout(function () {
            if (state !== 'countdown') return;
            if (!atTop()) {
                setState('manual');
                return;
            }
            choice.classList.add('sm-counting');
            hint.textContent = 'Playing in a moment…';
            countTimer = setTimeout(function () {
                if (state === 'countdown') start({i: 0, mid: false}, true);
            }, COUNTDOWN);
        }, 900);
    }
})();
