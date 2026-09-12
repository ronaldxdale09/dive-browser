#!/usr/bin/env bash
# Source before a native build/check; use one linkable macOS SDK consistently.
dive_native_toolchain() {
    [[ "$(uname -s)" == Darwin ]] || return 0
    if printf 'int main(){return 0;}' | cc -x c - -o /dev/null >/dev/null 2>&1; then
        return 0
    fi
    if [[ -n "${SDKROOT:-}" ]]; then
        echo "SDKROOT cannot link a minimal program: ${SDKROOT}" >&2
        return 1
    fi
    local dive_sdk
    for dive_sdk in "$(xcode-select -p)"/Platforms/MacOSX.platform/Developer/SDKs/MacOSX*.sdk; do
        [[ -d "${dive_sdk}" ]] || continue
        if printf 'int main(){return 0;}' | SDKROOT="${dive_sdk}" cc -x c - -o /dev/null >/dev/null 2>&1; then
            export SDKROOT="$(cd "${dive_sdk}" && pwd -P)"
            echo "Using linkable SDK: ${SDKROOT}"
            return 0
        fi
    done
    echo "No linkable macOS SDK found; check xcode-select and Command Line Tools" >&2
    return 1
}
dive_native_toolchain
