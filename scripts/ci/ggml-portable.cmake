# Toolchain file for CI builds of whisper.cpp (pulled in by whisper-rs-sys).
#
# ggml defaults to `-mcpu=native` and then probes the host for dotprod, i8mm
# and sve. GitHub's virtualised Apple Silicon runners report no i8mm, ggml
# appends `+noi8mm`, and Apple clang still defines __ARM_FEATURE_MATMUL_INT8
# for the native CPU, so ggml-cpu-quants.c calls an i8mm intrinsic from a
# function compiled without i8mm and the build fails. A fixed architecture
# sidesteps the probe and produces a binary every Apple Silicon Mac can run.
#
# whisper-rs-sys forwards any CMAKE_* environment variable as a define, and
# the cmake crate honours CMAKE_TOOLCHAIN_FILE itself, so the workflows set
#   CMAKE_TOOLCHAIN_FILE=<repo>/scripts/ci/ggml-portable.cmake
set(GGML_NATIVE OFF CACHE BOOL "ggml: optimize the build for the current system" FORCE)
if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64" OR CMAKE_HOST_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
  set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "ggml: CPU architecture for ARM" FORCE)
endif()
