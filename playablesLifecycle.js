// Makes the page honor the YouTube Playables pause and audio state from the first byte, before the engine and its SDK
// bindings exist and whatever the game code does. Load it right after the Playables SDK and before any engine script.
//
// Pause: input stays away from the engine, the engine main loop and every audio context are suspended, and network
// requests and response reads wait for resume. Audio: every audio context plays through a master gain that stays at
// zero while YouTube audio is off.
(function () {
    "use strict";

    const ytgame = window.ytgame;
    const system = ytgame && ytgame.system;

    // Outside a YouTube frame there is no host: the SDK reports audio as off on subscription and never pauses.
    const isHosted = !!(ytgame && ytgame.IN_PLAYABLES_ENV);

    let isPaused = false;
    let resumeWaiters = [];

    const waitForResume = () => isPaused ? new Promise((resolve) => resumeWaiters.push(resolve)) : Promise.resolve();
    const isHeld = () => isPaused;

    const input = createInputGate();
    const audio = createAudioGate();
    const mainLoop = createMainLoopGate();
    createNetworkGate(isHeld, waitForResume);

    function pause() {
        if (isPaused) return;
        isPaused = true;
        input.hold();
        mainLoop.hold();
        audio.hold();
    }

    function resume() {
        if (!isPaused) return;
        isPaused = false;
        input.release();
        audio.release();
        mainLoop.release();

        const waiters = resumeWaiters;
        resumeWaiters = [];
        for (const resolve of waiters) resolve();
    }

    // The SDK reports these calls to YouTube, and it replays the latest state to every listener on each new
    // subscription, so the handlers above are idempotent.
    if (system) {
        try {
            system.onPause(pause);
            system.onResume(resume);
        }
        catch (error) {
            console.error(error);
        }
        try {
            if (isHosted) {
                audio.setEnabled(system.isAudioEnabled());
                system.onAudioEnabledChange((isEnabled) => audio.setEnabled(isEnabled));
            }
        }
        catch (error) {
            console.error(error);
        }
    }

    // Unity's Module.preMainLoop hook, called with the module as "this" at the start of every frame. A frame that starts
    // while paused is skipped and the main loop is suspended right there, also during engine startup.
    function preMainLoop() {
        mainLoop.frameStarted(this);
        if (!isPaused) return true;
        mainLoop.hold();
        return false;
    }

    window.playablesLifecycle = Object.freeze({
        preMainLoop,
        // Hands over the Unity instance, for loaders that were not given preMainLoop in their config.
        attachUnity: function (unityInstance) {
            const unityModule = unityInstance && unityInstance.Module;
            mainLoop.attach(unityModule);
            if (unityModule && typeof unityModule.preMainLoop !== "function") unityModule.preMainLoop = preMainLoop;
        },
        isPaused: () => isPaused,
        isAudioEnabled: () => audio.isEnabled(),
    });

    // Keeps pointer, touch and keyboard events away from the engine during pause, so nothing is queued and replayed on
    // resume. A release of a press the engine already saw still passes, or the engine would keep a phantom touch or
    // a held button after resume.
    function createInputGate() {
        const trackingLimit = 64;
        const pressedButtons = new Set();
        const pressedPointers = new Set();
        const pressedTouches = new Set();
        const pressedKeys = new Set();
        let isBlocking = false;

        const track = (pressed, key) => {
            if (pressed.size >= trackingLimit) pressed.clear();
            pressed.add(key);
        };

        const block = (event) => {
            event.stopImmediatePropagation();
            // Keyboard defaults stay: browser shortcuts and Esc must keep working.
            if (event.cancelable && !event.type.startsWith("key")) event.preventDefault();
        };

        const onPress = (pressed, keyOf) => (event) => {
            if (isBlocking) block(event);
            else track(pressed, keyOf(event));
        };

        const onRelease = (pressed, keyOf) => (event) => {
            if (!pressed.delete(keyOf(event)) && isBlocking) block(event);
        };

        const onTouchPress = (event) => {
            if (isBlocking) {
                block(event);
                return;
            }
            for (const touch of event.changedTouches) track(pressedTouches, touch.identifier);
        };

        const onTouchRelease = (event) => {
            let isTracked = false;
            for (const touch of event.changedTouches) {
                if (pressedTouches.delete(touch.identifier)) isTracked = true;
            }
            if (!isTracked && isBlocking) block(event);
        };

        const onOther = (event) => {
            if (isBlocking) block(event);
        };

        const listeners = {
            mousedown: onPress(pressedButtons, (event) => event.button),
            mouseup: onRelease(pressedButtons, (event) => event.button),
            pointerdown: onPress(pressedPointers, (event) => event.pointerId),
            pointerup: onRelease(pressedPointers, (event) => event.pointerId),
            pointercancel: onRelease(pressedPointers, (event) => event.pointerId),
            keydown: onPress(pressedKeys, (event) => event.code),
            keyup: onRelease(pressedKeys, (event) => event.code),
            touchstart: onTouchPress,
            touchend: onTouchRelease,
            touchcancel: onTouchRelease,
        };
        for (const type of ["mousemove", "pointermove", "touchmove", "wheel", "click", "dblclick", "auxclick", "contextmenu", "keypress"]) {
            listeners[type] = onOther;
        }

        // Window capture listeners added before the engine run ahead of every engine listener.
        for (const type in listeners) {
            window.addEventListener(type, listeners[type], { capture: true, passive: false });
        }

        return {
            hold: () => { isBlocking = true; },
            release: () => { isBlocking = false; },
        };
    }

    // Records every audio context the engine creates. Each one plays through a master gain for the YouTube mute, and
    // is suspended during pause. While paused its resume() is deferred, because Unity resumes the context on any
    // click and from a timer.
    function createAudioGate() {
        const entries = [];
        const routes = new WeakMap();
        let isHolding = false;
        let isEnabled = true;

        const gate = {
            hold: () => { },
            release: () => { },
            setEnabled: (value) => { isEnabled = value !== false; },
            isEnabled: () => isEnabled,
        };

        const AudioNodeType = window.AudioNode;
        if (typeof AudioNodeType !== "function") return gate;

        const nativeConnect = AudioNodeType.prototype.connect;
        const nativeDisconnect = AudioNodeType.prototype.disconnect;

        // Connections to a recorded context's output go to its master gain instead.
        AudioNodeType.prototype.connect = function () {
            const master = arguments.length > 0 ? routes.get(arguments[0]) : undefined;
            if (!master) return nativeConnect.apply(this, arguments);
            const args = Array.prototype.slice.call(arguments);
            args[0] = master;
            return nativeConnect.apply(this, args);
        };

        AudioNodeType.prototype.disconnect = function () {
            const master = arguments.length > 0 ? routes.get(arguments[0]) : undefined;
            if (!master) return nativeDisconnect.apply(this, arguments);
            const args = Array.prototype.slice.call(arguments);
            args[0] = master;
            return nativeDisconnect.apply(this, args);
        };

        const liveEntries = () => {
            for (let index = entries.length - 1; index >= 0; index--) {
                if (entries[index].context.state === "closed") entries.splice(index, 1);
            }
            return entries;
        };

        const suspend = (entry) => {
            if (entry.context.state !== "running") return;
            entry.isSuspendedByGate = true;
            entry.context.suspend().catch(() => { });
        };

        const record = (context) => {
            try {
                const master = context.createGain();
                master.gain.value = isEnabled ? 1 : 0;
                nativeConnect.call(master, context.destination);
                routes.set(context.destination, master);

                const entry = { context, master, nativeResume: context.resume, isSuspendedByGate: false, isResumeWanted: false };
                context.resume = function () {
                    if (!isHolding) return entry.nativeResume.call(context);
                    entry.isResumeWanted = true;
                    return Promise.resolve();
                };
                entries.push(entry);
                if (isHolding) suspend(entry);
            }
            catch (error) {
                console.error(error);
            }
        };

        const wrapConstructor = (name) => {
            const NativeContext = window[name];
            if (typeof NativeContext !== "function") return;
            const RecordedContext = function () {
                const context = new NativeContext(...arguments);
                record(context);
                return context;
            };
            RecordedContext.prototype = NativeContext.prototype;
            window[name] = RecordedContext;
        };
        wrapConstructor("AudioContext");
        wrapConstructor("webkitAudioContext");

        gate.hold = () => {
            isHolding = true;
            for (const entry of liveEntries()) suspend(entry);
        };

        gate.release = () => {
            isHolding = false;
            for (const entry of liveEntries()) {
                if (!entry.isSuspendedByGate && !entry.isResumeWanted) continue;
                entry.isSuspendedByGate = false;
                entry.isResumeWanted = false;
                entry.nativeResume.call(entry.context).catch(() => { });
            }
        };

        gate.setEnabled = (value) => {
            isEnabled = value !== false;
            for (const entry of liveEntries()) entry.master.gain.value = isEnabled ? 1 : 0;
        };

        return gate;
    }

    // Holds the Unity main loop, so there is no game loop and no rendering while paused. The loop counts as present only
    // once a frame has started: the loader can resolve before Unity creates it, and resuming a loop that does not exist
    // yet would break the engine.
    function createMainLoopGate() {
        let unityModule = null;
        let attachedModule = null;
        let isHolding = false;

        const canPause = (module) => !!module && typeof module.pauseMainLoop === "function";

        const call = (name) => {
            try {
                unityModule[name]();
                return true;
            }
            catch (error) {
                console.error(error);
                return false;
            }
        };

        return {
            // The module the loader handed over, for engine versions that call preMainLoop without the module as "this".
            attach: (module) => {
                if (canPause(module)) attachedModule = module;
            },
            frameStarted: (module) => {
                if (canPause(module)) unityModule = module;
                else if (attachedModule) unityModule = attachedModule;
            },
            hold: () => {
                if (isHolding || !unityModule) return;
                isHolding = call("pauseMainLoop");
            },
            release: () => {
                if (!isHolding) return;
                isHolding = false;
                call("resumeMainLoop");
            },
        };
    }

    // New requests and reads of response bodies wait while paused. A paused body read lets the browser stop the
    // transfer, so downloads that were already running stop too.
    function createNetworkGate(isHeld, waitForResume) {
        const nativeFetch = window.fetch;
        if (typeof nativeFetch !== "function") return;

        const holdBodyReads = (response) => {
            const body = response && response.body;
            if (!body || typeof body.getReader !== "function") return response;

            const nativeGetReader = body.getReader;
            body.getReader = function () {
                const reader = nativeGetReader.apply(this, arguments);
                const nativeRead = reader.read;
                reader.read = function () {
                    if (!isHeld()) return nativeRead.call(reader);
                    return waitForResume().then(() => nativeRead.call(reader));
                };
                return reader;
            };
            return response;
        };

        window.fetch = function () {
            const args = arguments;
            const send = () => nativeFetch.apply(window, args).then(holdBodyReads);
            return isHeld() ? waitForResume().then(send) : send();
        };
    }
})();
