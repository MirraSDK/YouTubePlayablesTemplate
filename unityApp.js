const unityApp = {

    applyCommonFixes: function () {
        // Disable unwanted page scroll.
        window.addEventListener("wheel", (event) => event.preventDefault(), {
            passive: false,
        });

        // Disable unwanted key events.
        window.addEventListener("keydown", (event) => {
            if (["ArrowUp", "ArrowDown"].includes(event.key)) {
                event.preventDefault();
            }
        });

        // Disable context menu appearing after right click outside of the unity canvas.
        window.addEventListener('contextmenu', (event) => event.preventDefault());
        document.addEventListener('contextmenu', (event) => event.preventDefault());
    },

    // YouTube's content security policy only runs scripts that carry the page nonce. YouTube adds it to the tags of
    // index.html; scripts created from code, like the ones the Unity loader adds for the engine, get it here.
    applyScriptNonce: function () {
        const nonced = document.querySelector("script[nonce]");
        const nonce = nonced && (nonced.nonce || nonced.getAttribute("nonce"));
        if (!nonce) return;

        const nativeCreateElement = document.createElement;
        document.createElement = function (tagName) {
            const element = nativeCreateElement.apply(this, arguments);
            if (typeof tagName === "string" && tagName.toLowerCase() === "script" && !element.nonce) element.nonce = nonce;
            return element;
        };
    },

    // Tells YouTube that the game hit an error. The call is best effort and rate limited on its side.
    logErrorToYouTube: function () {
        const health = window.ytgame && window.ytgame.health;
        try {
            if (health && typeof health.logError === "function") health.logError();
        }
        catch (error) {
            console.error(error);
        }
    },

    // A failed load is shown on the page, because an embedded frame cannot open alert(), and is reported to YouTube.
    reportFailure: function (error) {
        console.error(error);
        try {
            if (window.pageLoader && typeof window.pageLoader.fail === "function") window.pageLoader.fail();
        }
        catch (failError) {
            console.error(failError);
        }
        this.logErrorToYouTube();
    },

    // YouTube keeps its own spinner until gameReady and no loading screen may stay up past that call, so the page
    // loader leaves with it, also when the game never hides the loader itself.
    hideLoaderOnGameReady: function (pageLoader) {
        const game = window.ytgame && window.ytgame.game;
        if (!game || typeof game.gameReady !== "function") return;

        const nativeGameReady = game.gameReady;
        try {
            game.gameReady = function () {
                pageLoader.hide();
                return nativeGameReady.apply(game, arguments);
            };
        }
        catch (error) {
            console.warn(error);
        }
    },

    // The page loader is already on screen, so YouTube may show the game; gameReady follows once the game is playable.
    // The SDK skips its own firstFrameReady call when this flag is set.
    notifyFirstFrameReady: function () {
        const game = window.ytgame && window.ytgame.game;
        if (!game || typeof game.firstFrameReady !== "function" || window.mirraYouTubeFirstFrameSent) {
            return;
        }
        try {
            game.firstFrameReady();
            window.mirraYouTubeFirstFrameSent = true;
        }
        catch (error) {
            console.error(error);
        }
    },

    // Downloads the zipped build files with combined progress and unzips each one into a blob as soon as it arrives.
    downloadArchives: function (archives, onProgress) {
        const loaded = archives.map(() => 0);
        const sizes = archives.map(() => 0);
        const report = () => {
            const total = sizes.reduce((sum, size) => sum + size, 0);
            onProgress(total > 0 ? loaded.reduce((sum, size) => sum + size, 0) / total : 0);
        };

        return Promise.all(archives.map((archive, index) =>
            this.downloadArchive(archive, (done, size) => {
                loaded[index] = done;
                sizes[index] = size;
                report();
            })));
    },

    // A dropped connection or a damaged response is tried again before the player is told that the game failed.
    downloadArchive: async function (archive, onProgress) {
        const attempts = 3;
        for (let attempt = 1; ; attempt++) {
            try {
                const bytes = await this.fetchWithProgress(archive.url, onProgress, attempt > 1);
                return await this.unzipToBlob(bytes, archive.name, archive.type);
            }
            catch (error) {
                if (attempt >= attempts) throw error;
                console.warn(`Attempt ${attempt} of ${attempts} failed for ${archive.url}:`, error);
                await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
        }
    },

    // A retry skips the browser cache, which may hold the damaged response.
    fetchWithProgress: async function (url, onProgress, isRetry) {
        const response = await fetch(url, isRetry ? { cache: "reload" } : undefined);
        if (!response.ok) throw new Error(`Download failed ${url}: ${response.status} ${response.statusText}`);

        const declaredSize = Number(response.headers.get("Content-Length")) || 0;
        if (!response.body) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            onProgress(bytes.length, bytes.length);
            return bytes;
        }

        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            onProgress(received, Math.max(declaredSize, received));
        }

        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        onProgress(received, received);
        return bytes;
    },

    // Inflates with the browser's native DecompressionStream, or with the bundled decoder where "deflate-raw" is missing.
    // Nothing is fetched from other domains: YouTube Playables forbids it.
    unzipToBlob: async function (bytes, fileName, mimeType) {
        const entry = this.findZipEntry(bytes, fileName);
        const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
        if (data.length !== entry.compressedSize) throw new Error("Truncated zip archive: " + fileName);

        if (entry.method === 0) return new Blob([data], { type: mimeType });
        if (entry.method !== 8) throw new Error(`Unsupported zip compression method ${entry.method}: ${fileName}`);

        // The engine must never get a partly inflated file, so the size is checked and the bundled decoder takes over
        // when the native one fails.
        let blob = null;
        if (this.supportsRawDeflateStream()) {
            try {
                const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
                blob = await new Response(stream).blob();
                if (blob.size !== entry.uncompressedSize) blob = null;
            }
            catch (error) {
                console.warn(error);
                blob = null;
            }
        }
        if (!blob) {
            if (typeof window.rawInflate !== "function") await this.loadScript("TemplateData/rawInflate.js");
            const inflated = window.rawInflate(data, entry.uncompressedSize);
            if (inflated.length !== entry.uncompressedSize) throw new Error("Damaged zip entry: " + fileName);
            blob = new Blob([inflated]);
        }

        return blob.slice(0, blob.size, mimeType);
    },

    // Blob URLs work with every version of the Unity loader. Where the page policy refuses to fetch them, the same
    // files are answered from memory under their build paths instead.
    publishBuildFiles: async function (files) {
        if (await this.canFetchBlobUrls()) return files.map((file) => URL.createObjectURL(file.blob));

        const blobs = new Map(files.map((file) => [file.url, file.blob]));
        const nativeFetch = window.fetch;
        window.fetch = function (resource) {
            const blob = typeof resource === "string" ? blobs.get(resource) : undefined;
            if (!blob) return nativeFetch.apply(window, arguments);
            return Promise.resolve(new Response(blob, {
                headers: { "Content-Type": blob.type, "Content-Length": String(blob.size) },
            }));
        };
        return files.map((file) => file.url);
    },

    canFetchBlobUrls: async function () {
        const url = URL.createObjectURL(new Blob(["blob"]));
        try {
            return (await fetch(url)).ok;
        }
        catch (error) {
            return false;
        }
        finally {
            URL.revokeObjectURL(url);
        }
    },

    // Chrome 80 to 102 has DecompressionStream but throws on the "deflate-raw" format.
    supportsRawDeflateStream: function () {
        if (typeof DecompressionStream !== "function") return false;
        try {
            new DecompressionStream("deflate-raw");
            return true;
        }
        catch (error) {
            return false;
        }
    },

    // Reads the zip central directory to find the entry, its compression method and where its data starts.
    findZipEntry: function (bytes, fileName) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let end = -1;
        for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
            if (view.getUint32(index, true) === 0x06054b50) {
                end = index;
                break;
            }
        }
        if (end < 0) throw new Error("Not a zip archive: " + fileName);

        const decoder = new TextDecoder();
        const count = view.getUint16(end + 10, true);
        let offset = view.getUint32(end + 16, true);
        let fallback = null;

        for (let index = 0; index < count; index++) {
            if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break;
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            const localOffset = view.getUint32(offset + 42, true);
            if (localOffset + 30 > bytes.length) throw new Error("Truncated zip archive: " + fileName);
            const entry = {
                method: view.getUint16(offset + 10, true),
                compressedSize: view.getUint32(offset + 20, true),
                uncompressedSize: view.getUint32(offset + 24, true),
                dataOffset: localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true),
            };
            if (name === fileName) return entry;
            if (!fallback && !name.endsWith("/")) fallback = entry;
            offset += 46 + nameLength + extraLength + commentLength;
        }

        if (fallback) return fallback;
        throw new Error("File not found in zip: " + fileName);
    },

    loadScript: function (url) {
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = url;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("Failed to load " + url));
            document.head.appendChild(script);
        });
    },

    // One loading bar from opening the page until the first playable scene. The game reports its own
    // content progress and hides the bar through PageLoader.jslib once it is ready.
    createPageLoader: function () {
        const element = document.querySelector("#unity-loading-bar");
        const fill = document.querySelector("#unity-progress-bar-full");
        const failure = document.querySelector("#unity-load-error");
        const weights = { download: 0.6, engine: 0.1, content: 0.3 };
        const progress = { download: 0, engine: 0, content: 0 };
        let shown = 0;
        let isHidden = false;
        let isFailed = false;

        const render = () => {
            const value = weights.download * progress.download + weights.engine * progress.engine + weights.content * progress.content;
            shown = Math.max(shown, Math.min(1, value));
            fill.style.width = (100 * shown) + "%";
        };

        return {
            show: function () {
                element.style.display = "flex";
            },
            setStage: function (stage, value) {
                if (isHidden) return;
                progress[stage] = Math.max(progress[stage], Math.min(1, value || 0));
                render();
            },
            setContentProgress: function (value) {
                this.setStage("content", value);
            },
            // Nothing playable is behind a failed load, so the loader stays up with a message in place of the bar.
            fail: function () {
                isFailed = true;
                element.style.display = "flex";
                fill.parentElement.style.display = "none";
                if (failure) failure.style.display = "block";
            },
            hide: function () {
                if (isHidden || isFailed) return;
                isHidden = true;
                element.style.display = "none";

                // Lets tools measure what was downloaded before the game became playable.
                if (window.performance && performance.mark) performance.mark("game-ready");
            },
        };
    },

    tryRotationLock() {
        const PORTRAIT_ONLY = "{{{ PORTRAIT_ONLY }}}";
        let isPortraitLocked = false;
        if (!unityApp.isEmpty(PORTRAIT_ONLY)) {
            isPortraitLocked = unityApp.toBoolean(PORTRAIT_ONLY);
        }

        const LANDSCAPE_ONLY = "{{{ LANDSCAPE_ONLY }}}";
        let isLandscapeLocked = false;
        if (!unityApp.isEmpty(LANDSCAPE_ONLY)) {
            isLandscapeLocked = unityApp.toBoolean(LANDSCAPE_ONLY);
        }

        if (isPortraitLocked && isLandscapeLocked) {
            console.warn("Both portrait and landscape lock are enabled, so neither is applied.");
            return;
        }

        const root = document.createElement("div");

        // Stretch to full screen.
        root.style.background = 'rgb(10, 10, 10, 0.7)';
        root.style.display = 'flex';
        root.style.position = 'fixed';
        root.style.top = '0';
        root.style.left = '0';
        root.style.width = '100%';
        root.style.height = '100%';

        // Create blur background effect.
        root.style.webkitBackfaceVisibility = 'hidden';
        root.style.webkitPerspective = '1000';
        root.style.webkitTransform = 'translate3d(0,0,0)';
        root.style.webkitTransform = 'translateZ(0)';
        root.style.backfaceVisibility = 'hidden';
        root.style.perspective = '1000';
        root.style.transform = 'translate3d(0,0,0)';
        root.style.transform = 'translateZ(0)';
        root.style.backdropFilter = 'blur(10px)';

        // Create intuitive image instruction for the user.
        const image = document.createElement('img');
        if (isPortraitLocked) {
            image.src = 'TemplateData/portrait-only.png';
        }
        else if (isLandscapeLocked) {
            image.src = 'TemplateData/landscape-only.png';
        }
        image.style.display = 'flex';
        image.style.width = '100px';
        image.style.height = '100px';
        image.style.margin = 'auto';
        root.appendChild(image);

        document.body.appendChild(root);

        function updateRotationLock() {
            let display = 'none';
            if (unityApp.isMobile()) {
                if (isPortraitLocked && isLandscapeLocked) {
                    root.style.display = display;
                    return;
                }
                if (isPortraitLocked) {
                    display = window.innerHeight < window.innerWidth ? 'flex' : 'none';
                }
                else if (isLandscapeLocked) {
                    display = window.innerHeight > window.innerWidth ? 'flex' : 'none';
                }
            }
            root.style.display = display;
        }

        // Subscribe to window and document events.
        window.addEventListener("load", updateRotationLock);
        window.addEventListener("resize", updateRotationLock);
        document.addEventListener("readystatechange", updateRotationLock);
        document.addEventListener("DOMContentLoaded", updateRotationLock);

        // Update rotation lock on start.
        updateRotationLock();
    },

    tryLockAspectRatio() {
        const mobilePortraitAspectRatio = "{{{ MOBILE_PORTRAIT_ASPECT_RATIO }}}";
        const mobileLandscapeAspectRatio = "{{{ MOBILE_LANDSCAPE_ASPECT_RATIO }}}";
        const desktopAspectRatio = "{{{ DESKTOP_ASPECT_RATIO }}}";

        const isMobilePortraitLocked = !this.isEmpty(mobilePortraitAspectRatio);
        const isMobileLandscapeLocked = !this.isEmpty(mobileLandscapeAspectRatio);
        const isDesktopLocked = !this.isEmpty(desktopAspectRatio);

        const container = document.querySelector("#unity-container");
        const canvas = document.querySelector("#unity-canvas");

        function centerCanvas() {
            canvas.style.margin = "auto";
            canvas.style.top = "0";
            canvas.style.left = "0";
            canvas.style.bottom = "0";
            canvas.style.right = "0";
        }

        function resetAspectRatio() {
            canvas.style.width = "100%";
            canvas.style.height = "100%";
            centerCanvas();
        }

        function isPortraitMode() {
            const containerWidth = container.clientWidth;
            const containerHeight = container.clientHeight;
            return containerHeight > containerWidth;
        }

        function recalculateAspectRatio(aspectRatio) {
            const containerWidth = container.clientWidth;
            const containerHeight = container.clientHeight;

            // YouTube first loads the game in a view of zero size: the canvas keeps filling it until a real size arrives.
            if (!(containerWidth > 0 && containerHeight > 0 && aspectRatio > 0)) return;

            if (containerWidth / containerHeight > aspectRatio) {
                canvas.style.width = Math.floor(containerHeight * aspectRatio) + "px";
                canvas.style.height = "100%";
            }
            else {
                canvas.style.width = "100%";
                canvas.style.height = Math.floor(containerWidth / aspectRatio) + "px";
            }
        }

        function updateAspectRatio() {
            resetAspectRatio();
            if (unityApp.isMobile()) {
                if (isPortraitMode()) {
                    if (isMobilePortraitLocked) {
                        recalculateAspectRatio(unityApp.toNumber(mobilePortraitAspectRatio));
                    }
                }
                else {
                    if (isMobileLandscapeLocked) {
                        recalculateAspectRatio(unityApp.toNumber(mobileLandscapeAspectRatio));
                    }
                }
            }
            else {
                if (isDesktopLocked) {
                    recalculateAspectRatio(unityApp.toNumber(desktopAspectRatio));
                }
            }
            centerCanvas();
        }

        // Subscribe to window and document events.
        window.addEventListener("load", updateAspectRatio);
        window.addEventListener("resize", updateAspectRatio);
        document.addEventListener("readystatechange", updateAspectRatio);
        document.addEventListener("DOMContentLoaded", updateAspectRatio);

        // Update aspect ratio on start.
        updateAspectRatio();
    },

    startLoading: async function () {
        const canvas = document.querySelector("#unity-canvas");
        const pageLoader = this.createPageLoader();
        window.pageLoader = pageLoader;
        pageLoader.show();
        this.notifyFirstFrameReady();
        this.hideLoaderOnGameReady(pageLoader);

        const buildUrl = "Build";
        const dataPath = buildUrl + "/{{{ DATA_FILENAME }}}";
        const codePath = buildUrl + "/{{{ CODE_FILENAME }}}";

        const [dataBlob, codeBlob] = await this.downloadArchives([
            { url: dataPath + ".zip", name: "{{{ DATA_FILENAME }}}", type: "application/octet-stream" },
            { url: codePath + ".zip", name: "{{{ CODE_FILENAME }}}", type: "application/wasm" },
        ], (progress) => pageLoader.setStage("download", progress));

        const [dataUrl, codeUrl] = await this.publishBuildFiles([
            { url: dataPath, blob: dataBlob },
            { url: codePath, blob: codeBlob },
        ]);

        const loaderUrl = buildUrl + "/{{{ LOADER_FILENAME }}}";
        const config = {
            arguments: [],
            dataUrl: dataUrl,
            frameworkUrl: buildUrl + "/{{{ FRAMEWORK_FILENAME }}}",
            #if USE_THREADS
        workerUrl: buildUrl + "/{{{ WORKER_FILENAME }}}",
            #endif
        #if USE_WASM
        codeUrl: codeUrl,
            #endif
        #if SYMBOLS_FILENAME
        symbolsUrl: buildUrl + "/{{{ SYMBOLS_FILENAME }}}",
            #endif
        streamingAssetsUrl: "StreamingAssets",
            companyName: "{{{ COMPANY_NAME }}}",
            productName: "{{{ PRODUCT_NAME }}}",
            productVersion: "{{{ PRODUCT_VERSION }}}",
            showBanner: (msg, type) => {
                switch (type) {
                    case 'error': {
                        console.error(msg);
                        break;
                    }
                    default: {
                        console.warn(msg);
                        break;
                    }
                }
            },
            // Unity reports runtime errors with alert(), which an embedded frame cannot open. They go to the console
            // and to YouTube instead.
            errorHandler: (message, filename, lineno) => {
                console.error(message, filename, lineno);
                unityApp.logErrorToYouTube();
                return true;
            },
            // The build files arrive as blob URLs and must not be cached again on every launch; hashed bundles never
            // change, so they are served from the cache without revalidation; everything else, like the catalog, is fetched fresh.
            cacheControl: (url) => {
                if (/\.bundle$/.test(url) && !/catalog\.bundle$/.test(url)) return "immutable";
                return "no-store";
            },
        };

        // Every frame checks the YouTube pause, from the first one Unity runs.
        const lifecycle = window.playablesLifecycle;
        if (lifecycle) {
            config.preMainLoop = lifecycle.preMainLoop;
        }

        // By default Unity keeps WebGL canvas render target size matched with
        // the DOM size of the canvas element (scaled by window.devicePixelRatio)
        // Set this to false if you want to decouple this synchronization from
        // happening inside the engine, and you would instead like to size up
        // the canvas DOM size and WebGL render target sizes yourself.
        const matchWebGLToCanvasSize = "{{{ MATCH_WEBGL_TO_CANVAS_SIZE }}}";
        if (!this.isEmpty(matchWebGLToCanvasSize)) {
            config.matchWebGLToCanvasSize = this.toBoolean(matchWebGLToCanvasSize);
        }

        // If you would like all file writes inside Unity Application.persistentDataPath
        // directory to automatically persist so that the contents are remembered when
        // the user revisits the site the next time, uncomment the following line:
        // Defaults to on: it is Unity's recommended behavior and avoids its deprecation warning for manual syncing.
        const autoSyncPersistentDataPath = "{{{ AUTO_SYNC_PERSISTENT_DATA_PATH }}}";
        config.autoSyncPersistentDataPath = this.isEmpty(autoSyncPersistentDataPath) || this.toBoolean(autoSyncPersistentDataPath);

        // To lower canvas resolution on mobile devices to gain some
        // performance, uncomment the following line:
        const devicePixelRatio = this.toNumber("{{{ DEVICE_PIXEL_RATIO }}}");
        if (this.isNumber(devicePixelRatio) && devicePixelRatio != 0) {
            config.devicePixelRatio = this.toNumber(devicePixelRatio);
        }

        await this.loadScript(loaderUrl);
        if (typeof createUnityInstance !== "function") {
            throw new Error("The Unity loader did not define createUnityInstance: " + loaderUrl);
        }

        const unityInstance = await createUnityInstance(canvas, config, (progress) => {
            pageLoader.setStage("engine", progress);
        });
        pageLoader.setStage("engine", 1);
        if (lifecycle) lifecycle.attachUnity(unityInstance);

        // The game hides the loader when its first scene is playable; this only keeps a broken boot from hiding behind it.
        setTimeout(() => pageLoader.hide(), 180000);

        #if SHOW_DIAGNOSTICS
        // Position the diagnostics icon in the corner on the canvas.
        const diagnostics_icon = document.getElementById("diagnostics-icon");
        diagnostics_icon.onclick = () => {
            unityDiagnostics.openDiagnosticsDiv(unityInstance.GetMetricsInfo);
        };
        canvas.after(diagnostics_icon);
        #endif
    },

    isMobile: function () {
        return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    },

    isEmpty: function (value) {
        return value === undefined || value === null || value === "";
    },

    toBoolean: function (value) {
        return value === true || value === "true" || value === 1 || value === "1" || value === "True";
    },

    isNumber: function (value) {
        return typeof value === 'number' && !isNaN(value);
    },

    toNumber: function (value) {
        function handleMathExpression(str) {
            const mathMatch = str.match(/^(\d*\.?\d+)\s*([+\-*/])\s*(\d*\.?\d+)$/);
            if (!mathMatch) return null;

            const a = parseFloat(mathMatch[1]);
            const operator = mathMatch[2];
            const b = parseFloat(mathMatch[3]);

            const operators = {
                '+': function (a, b) { return a + b; },
                '-': function (a, b) { return a - b; },
                '*': function (a, b) { return a * b; },
                '/': function (a, b) { return b !== 0 ? a / b : NaN; }
            };
            return operators[operator](a, b);
        }

        function convertToNumber(str) {
            const num = parseFloat(str);
            return isNaN(num) ? 0 : num;
        }

        // Handle basic type checks first.
        if (this.isNumber(value)) return value;
        if (this.isEmpty(value)) return 0;

        // Convert to string and handle empty case.
        var str = String(value).trim();
        if (str === '') return 0;

        // Try math expression or simple number conversion.
        return handleMathExpression(str) || convertToNumber(str);
    },

};

// Prepare the page: script nonce, common fixes, rotation lock and aspect ratio lock.
// A step that fails must never keep the game from loading.
for (const step of ["applyScriptNonce", "applyCommonFixes", "tryRotationLock", "tryLockAspectRatio"]) {
    try {
        unityApp[step]();
    }
    catch (error) {
        console.error(error);
    }
}

// Automatically start after script is loaded. Every failure on the way ends on the page, not in an unhandled rejection.
unityApp.startLoading().catch((error) => unityApp.reportFailure(error));
