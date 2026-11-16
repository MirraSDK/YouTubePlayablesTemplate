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

    // Downloads the zipped build files with combined progress and unzips each into a blob URL.
    downloadArchives: async function (archives, onProgress) {
        const loaded = archives.map(() => 0);
        const sizes = archives.map(() => 0);
        const report = () => {
            const total = sizes.reduce((sum, size) => sum + size, 0);
            onProgress(total > 0 ? loaded.reduce((sum, size) => sum + size, 0) / total : 0);
        };

        const buffers = await Promise.all(archives.map((archive, index) =>
            this.fetchWithProgress(archive.url, (done, size) => {
                loaded[index] = done;
                sizes[index] = size;
                report();
            })));

        return Promise.all(archives.map((archive, index) =>
            this.unzipToBlobUrl(buffers[index], archive.name, archive.type)));
    },

    fetchWithProgress: async function (url, onProgress) {
        const response = await fetch(url);
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
    unzipToBlobUrl: async function (bytes, fileName, mimeType) {
        const entry = this.findZipEntry(bytes, fileName);
        const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
        let blob;

        if (entry.method === 0) {
            blob = new Blob([data], { type: mimeType });
        }
        else if (entry.method !== 8) {
            throw new Error(`Unsupported zip compression method ${entry.method}: ${fileName}`);
        }
        else if (this.supportsRawDeflateStream()) {
            const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
            blob = new Blob([await new Response(stream).blob()], { type: mimeType });
        }
        else {
            if (typeof window.rawInflate !== "function") await this.loadScript("TemplateData/rawInflate.js");
            blob = new Blob([window.rawInflate(data, entry.uncompressedSize)], { type: mimeType });
        }

        return URL.createObjectURL(blob);
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
            if (view.getUint32(offset, true) !== 0x02014b50) break;
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            const localOffset = view.getUint32(offset + 42, true);
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
            script.onload = resolve;
            script.onerror = () => reject(new Error("Failed to load " + url));
            document.head.appendChild(script);
        });
    },

    // One loading bar from opening the page until the first playable scene. The game reports its own
    // content progress and hides the bar through PageLoader.jslib once it is ready.
    createPageLoader: function () {
        const element = document.querySelector("#unity-loading-bar");
        const fill = document.querySelector("#unity-progress-bar-full");
        const weights = { download: 0.6, engine: 0.1, content: 0.3 };
        const progress = { download: 0, engine: 0, content: 0 };
        let shown = 0;
        let isHidden = false;

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
            hide: function () {
                if (isHidden) return;
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

        const buildUrl = "Build";

        let dataBlobUrl, codeBlobUrl;
        try {
            [dataBlobUrl, codeBlobUrl] = await this.downloadArchives([
                { url: buildUrl + "/{{{ DATA_FILENAME }}}.zip", name: "{{{ DATA_FILENAME }}}", type: "application/octet-stream" },
                { url: buildUrl + "/{{{ CODE_FILENAME }}}.zip", name: "{{{ CODE_FILENAME }}}", type: "application/wasm" },
            ], (progress) => pageLoader.setStage("download", progress));
        }
        catch (error) {
            console.error(error);
            alert("The game failed to download. Please check your connection and reload.");
            return;
        }

        const loaderUrl = buildUrl + "/{{{ LOADER_FILENAME }}}";
        const config = {
            arguments: [],
            dataUrl: dataBlobUrl,
            frameworkUrl: buildUrl + "/{{{ FRAMEWORK_FILENAME }}}",
            #if USE_THREADS
        workerUrl: buildUrl + "/{{{ WORKER_FILENAME }}}",
            #endif
        #if USE_WASM
        codeUrl: codeBlobUrl,
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

        const script = document.createElement("script");
        script.src = loaderUrl;
        script.onload = () => {
            createUnityInstance(canvas, config, (progress) => {
                pageLoader.setStage("engine", progress);
            }).then((unityInstance) => {
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
            }).catch((message) => {
                pageLoader.hide();
                alert(message);
            });
        };
        document.body.appendChild(script);
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

// Automatically start after script is loaded.
unityApp.startLoading();
