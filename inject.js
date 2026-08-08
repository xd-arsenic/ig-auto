(() => {
  "use strict";

  const defineGetter = (obj, prop, getter) => {
    try {
      Object.defineProperty(obj, prop, { get: getter, configurable: true });
    } catch (_) {
      /* ignore */
    }
  };

  // 1) navigator.webdriver -> undefined (classic automation signal).
  try {
    defineGetter(navigator, "webdriver", () => undefined);
    const proto = Object.getPrototypeOf(navigator);
    if (proto && "webdriver" in proto) {
      defineGetter(proto, "webdriver", () => undefined);
    }
  } catch (_) {
    /* ignore */
  }

  // 2) Present a realistic window.chrome so the page looks like ordinary Chrome
  //    rather than a stripped/automated environment.
  try {
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", {
        value: {},
        configurable: true,
        writable: true,
        enumerable: false,
      });
    }

    if (!window.chrome.runtime) {
      Object.defineProperty(window.chrome, "runtime", {
        value: {
          OnInstalledReason: {
            CHROME_UPDATE: "chrome_update",
            INSTALL: "install",
            SHARED_MODULE_UPDATE: "shared_module_update",
            UPDATE: "update",
          },
          OnRestartRequiredReason: {
            APP_UPDATE: "app_update",
            OS_UPDATE: "os_update",
            PERIODIC: "periodic",
          },
          PlatformArch: {
            ARM: "arm",
            ARM64: "arm64",
            MIPS: "mips",
            MIPS64: "mips64",
            X86_32: "x86-32",
            X86_64: "x86-64",
          },
          PlatformNaclArch: {
            ARM: "arm",
            MIPS: "mips",
            MIPS64: "mips64",
            X86_32: "x86-32",
            X86_64: "x86-64",
          },
          PlatformOs: {
            ANDROID: "android",
            CROS: "cros",
            LINUX: "linux",
            MAC: "mac",
            OPENBSD: "openbsd",
            WIN: "win",
          },
          RequestUpdateCheckStatus: {
            NO_UPDATE: "no_update",
            THROTTLED: "throttled",
            UPDATE_AVAILABLE: "update_available",
          },
        },
        configurable: true,
        writable: true,
        enumerable: false,
      });
    }

    if (!window.chrome.app) {
      Object.defineProperty(window.chrome, "app", {
        value: {
          isInstalled: false,
          InstallState: {
            DISABLED: "disabled",
            INSTALLED: "installed",
            NOT_INSTALLED: "not_installed",
          },
          RunningState: {
            CANNOT_RUN: "cannot_run",
            READY_TO_RUN: "ready_to_run",
            RUNNING: "running",
          },
        },
        configurable: true,
        writable: true,
        enumerable: false,
      });
    }
  } catch (_) {
    /* ignore */
  }

  // 3) permissions.query for notifications should agree with Notification.permission
  //    (a mismatch here is a well-known headless tell).
  try {
    const perms = navigator.permissions;
    const original = perms && perms.query;
    if (original) {
      perms.query = function (parameters) {
        if (parameters && parameters.name === "notifications") {
          return Promise.resolve({
            state: (window.Notification && Notification.permission) || "default",
            onchange: null,
          });
        }
        return original.call(perms, parameters);
      };
    }
  } catch (_) {
    /* ignore */
  }

  // 4) Never expose an empty languages list (automation smell).
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      defineGetter(navigator, "languages", () => ["en-US", "en"]);
    }
  } catch (_) {
    /* ignore */
  }
})();
