# Toolchain file for CI builds of the CMake dependencies -- whisper.cpp via
# whisper-rs-sys, and anything else the cmake crate configures.
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

# A program links one C++ runtime. cef-dll-sys builds libcef_dll_wrapper with
# the static one (CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded, i.e. /MT), and
# whisper.cpp defaults to the dynamic one, so the two arrive with their own
# copies of std::locale and the link ends in fifty-odd LNK2005s. Match CEF:
# it is the dependency with no say in the matter.
#
# Only x64 sees this. whisper.cpp is not built for Windows-on-ARM at all, so
# the development VM links a binary that CI could not.
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded" CACHE STRING "" FORCE)
  # That variable alone is not enough. The cmake crate hands CMake the compiler
  # flags the cc crate chose, and cc asks for the dynamic runtime unless Rust
  # is building with +crt-static -- so the flags arrive containing /MD, as a
  # cache entry set before this file is read. An explicit /MD in the flags
  # beats CMAKE_MSVC_RUNTIME_LIBRARY, which is why the first attempt at this
  # changed nothing and the linker still reported MD_DynamicRelease.
  foreach(lang C CXX)
    foreach(suffix "" _DEBUG _RELEASE _RELWITHDEBINFO _MINSIZEREL)
      set(flags CMAKE_${lang}_FLAGS${suffix})
      if(DEFINED ${flags})
        # /MDd becomes /MTd: the trailing d is the debug runtime, not the kind.
        string(REGEX REPLACE "[-/]MD" "/MT" ${flags} "${${flags}}")
        set(${flags} "${${flags}}" CACHE STRING "" FORCE)
      endif()
    endforeach()
  endforeach()
endif()
if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64" OR CMAKE_HOST_SYSTEM_PROCESSOR MATCHES "arm64|aarch64")
  set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "ggml: CPU architecture for ARM" FORCE)
endif()
