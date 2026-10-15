(function registerWhatsAppSessionState(global) {
    const disconnectedStates = new Set([
        "disconnected",
        "disconnectedmobile",
        "unpaired",
        "serverclose",
        "browserclose",
        "conflict",
        "timeout",
        "logout"
    ]);

    function classify(state) {
        const stateCode = String(state || "").trim().toLowerCase().replace(/[\s_-]/g, "");

        if ([...disconnectedStates].some(offlineState =>
            stateCode === offlineState || stateCode.startsWith(offlineState)
        )) return "disconnected";

        if (stateCode === "connected" || stateCode === "inchat") return "connected";
        if (stateCode === "qrreadsuccess" || stateCode.includes("connecting") || stateCode.includes("opening")) {
            return "connecting";
        }
        if (stateCode.includes("qr") || stateCode.includes("notlogged")) return "qr";
        return "unknown";
    }

    global.ZapConnectSessionState = Object.freeze({ classify });
})(window);
