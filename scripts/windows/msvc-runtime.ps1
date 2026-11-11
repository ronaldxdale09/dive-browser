# msvc-runtime.ps1 -- make whisper.cpp and CEF agree on a C++ runtime.
#
# Dot-source it before building, in the same shell:
#
#     . scripts\windows\msvc-runtime.ps1
#
# CEF's libcef_dll_wrapper is built against the static C++ runtime (/MT).
# whisper.cpp (via whisper-rs-sys) defaults to the dynamic one (/MD), and
# linking the two into one binary ends in duplicate std::locale symbols. The
# flags below force the static runtime everywhere. All three kinds are needed
# because the runtime flag can be set in three places and the last one wins:
# CFLAGS/CXXFLAGS (cc appends them after its own -MD), the CMAKE_*_FLAGS_RELEASE
# pair (CMake appends per-config flags after those and its MSVC default carries
# /MD), and CMAKE_MSVC_RUNTIME_LIBRARY (the documented knob). Written with a
# leading dash, not a slash, so MSYS does not rewrite /MT into a POSIX path.
#
# SOURCE OF TRUTH: .github/workflows/ci.yml ("Match CEF's C++ runtime", with
# the reasoning in the comments above it); release.yml repeats it. This file
# and those steps must change together.
#
# Process scope only, on purpose: machine-wide CFLAGS would change every other
# C build on the computer.
if ($env:PROCESSOR_ARCHITECTURE -eq "AMD64") {
    $env:CFLAGS = "-MT"
    $env:CXXFLAGS = "-MT"
    $env:CMAKE_C_FLAGS_RELEASE = "-MT -O2 -Ob2 -DNDEBUG"
    $env:CMAKE_CXX_FLAGS_RELEASE = "-MT -O2 -Ob2 -DNDEBUG"
    $env:CMAKE_MSVC_RUNTIME_LIBRARY = "MultiThreaded"
    Write-Output "msvc-runtime: static C++ runtime flags set for this shell (x64)"
} else {
    Write-Output "msvc-runtime: nothing set on $env:PROCESSOR_ARCHITECTURE -- whisper.cpp is not built there (see docs/WINDOWS.md, Live subtitles on Windows-on-ARM)"
}
