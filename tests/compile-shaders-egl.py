"""Compile exact application shader pairs using installed surfaceless Mesa GLES.

This executes the native GLSL compiler/linker, not a browser or screenshot path.
It performs no installation and opens no server or network connection.
"""
from __future__ import annotations

import ctypes as C
import json
import sys

EGL_NONE = 0x3038
EGL_PLATFORM_SURFACELESS_MESA = 0x31DD
EGL_OPENGL_ES_API = 0x30A0
EGL_RENDERABLE_TYPE = 0x3040
EGL_OPENGL_ES3_BIT = 0x0040
EGL_SURFACE_TYPE = 0x3033
EGL_PBUFFER_BIT = 0x0001
EGL_CONTEXT_CLIENT_VERSION = 0x3098
EGL_WIDTH = 0x3057
EGL_HEIGHT = 0x3056
GL_VERTEX_SHADER = 0x8B31
GL_FRAGMENT_SHADER = 0x8B30
GL_COMPILE_STATUS = 0x8B81
GL_LINK_STATUS = 0x8B82
GL_INFO_LOG_LENGTH = 0x8B84

egl = C.CDLL("libEGL.so.1")


def egl_function(name, result, args):
    function = getattr(egl, name)
    function.restype = result
    function.argtypes = args
    return function


get_proc = egl_function("eglGetProcAddress", C.c_void_p, [C.c_char_p])
get_error = egl_function("eglGetError", C.c_uint, [])
initialize = egl_function("eglInitialize", C.c_uint, [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)])
query_string = egl_function("eglQueryString", C.c_char_p, [C.c_void_p, C.c_int])
bind_api = egl_function("eglBindAPI", C.c_uint, [C.c_uint])
choose_config = egl_function("eglChooseConfig", C.c_uint, [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_void_p), C.c_int, C.POINTER(C.c_int)])
create_context = egl_function("eglCreateContext", C.c_void_p, [C.c_void_p, C.c_void_p, C.c_void_p, C.POINTER(C.c_int)])
create_surface = egl_function("eglCreatePbufferSurface", C.c_void_p, [C.c_void_p, C.c_void_p, C.POINTER(C.c_int)])
make_current = egl_function("eglMakeCurrent", C.c_uint, [C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p])
destroy_surface = egl_function("eglDestroySurface", C.c_uint, [C.c_void_p, C.c_void_p])
destroy_context = egl_function("eglDestroyContext", C.c_uint, [C.c_void_p, C.c_void_p])
terminate = egl_function("eglTerminate", C.c_uint, [C.c_void_p])


def require(value, action):
    if not value:
        raise RuntimeError(f"{action}: EGL error {get_error():#x}")
    return value


def proc(name, result, args):
    address = get_proc(name.encode())
    if not address:
        raise RuntimeError(f"Missing GLES function {name}")
    return C.CFUNCTYPE(result, *args)(address)


def main():
    supplied = json.load(open(sys.argv[1], encoding="utf-8"))
    get_display_address = require(get_proc(b"eglGetPlatformDisplayEXT"), "Get surfaceless display function")
    get_display = C.CFUNCTYPE(C.c_void_p, C.c_uint, C.c_void_p, C.POINTER(C.c_int))(get_display_address)
    display = require(get_display(EGL_PLATFORM_SURFACELESS_MESA, None, None), "Get display")
    major, minor = C.c_int(), C.c_int()
    require(initialize(display, C.byref(major), C.byref(minor)), "Initialize display")
    context = surface = None
    try:
        require(bind_api(EGL_OPENGL_ES_API), "Bind GLES API")
        config_attrs = (C.c_int * 13)(EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
                                      0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, EGL_NONE)
        config, count = C.c_void_p(), C.c_int()
        require(choose_config(display, config_attrs, C.byref(config), 1, C.byref(count)), "Choose GLES3 config")
        require(count.value > 0, "Find GLES3 config")
        context_attrs = (C.c_int * 3)(EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE)
        context = require(create_context(display, config, None, context_attrs), "Create GLES3 context")
        surface_attrs = (C.c_int * 5)(EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE)
        surface = require(create_surface(display, config, surface_attrs), "Create pbuffer")
        require(make_current(display, surface, surface, context), "Make GLES3 current")

        get_string = proc("glGetString", C.c_char_p, [C.c_uint])
        create_shader = proc("glCreateShader", C.c_uint, [C.c_uint])
        shader_source = proc("glShaderSource", None, [C.c_uint, C.c_int, C.POINTER(C.c_char_p), C.POINTER(C.c_int)])
        compile_shader = proc("glCompileShader", None, [C.c_uint])
        shader_int = proc("glGetShaderiv", None, [C.c_uint, C.c_uint, C.POINTER(C.c_int)])
        shader_log = proc("glGetShaderInfoLog", None, [C.c_uint, C.c_int, C.POINTER(C.c_int), C.c_void_p])
        delete_shader = proc("glDeleteShader", None, [C.c_uint])
        create_program = proc("glCreateProgram", C.c_uint, [])
        attach_shader = proc("glAttachShader", None, [C.c_uint, C.c_uint])
        link_program = proc("glLinkProgram", None, [C.c_uint])
        program_int = proc("glGetProgramiv", None, [C.c_uint, C.c_uint, C.POINTER(C.c_int)])
        program_log = proc("glGetProgramInfoLog", None, [C.c_uint, C.c_int, C.POINTER(C.c_int), C.c_void_p])
        delete_program = proc("glDeleteProgram", None, [C.c_uint])

        def log(handle, getter, logger):
            size = C.c_int()
            getter(handle, GL_INFO_LOG_LENGTH, C.byref(size))
            if size.value < 1:
                return ""
            output = C.create_string_buffer(size.value)
            logger(handle, size.value, None, output)
            return output.value.decode(errors="replace")

        results = []
        for source in supplied["programs"]:
            shaders, errors, warnings = [], [], []
            program = None
            try:
                for label, kind in [("vertex", GL_VERTEX_SHADER), ("fragment", GL_FRAGMENT_SHADER)]:
                    shader = create_shader(kind)
                    shaders.append(shader)
                    data = source[label].encode()
                    strings = (C.c_char_p * 1)(data)
                    shader_source(shader, 1, strings, None)
                    compile_shader(shader)
                    ok = C.c_int()
                    shader_int(shader, GL_COMPILE_STATUS, C.byref(ok))
                    diagnostic = log(shader, shader_int, shader_log)
                    if not ok.value:
                        errors.append({"stage": label, "log": diagnostic})
                    elif diagnostic.strip():
                        warnings.append({"stage": label, "log": diagnostic})
                if not errors:
                    program = create_program()
                    for shader in shaders:
                        attach_shader(program, shader)
                    link_program(program)
                    ok = C.c_int()
                    program_int(program, GL_LINK_STATUS, C.byref(ok))
                    diagnostic = log(program, program_int, program_log)
                    if not ok.value:
                        errors.append({"stage": "link", "log": diagnostic})
                    elif diagnostic.strip():
                        warnings.append({"stage": "link", "log": diagnostic})
                results.append({"name": source["name"], "status": "fail" if errors else "pass", "errors": errors, "warnings": warnings})
            finally:
                if program:
                    delete_program(program)
                for shader in shaders:
                    delete_shader(shader)
        output = {
            "htmlPath": supplied.get("htmlPath"),
            "eglVersion": f"{major.value}.{minor.value}",
            "eglVendor": query_string(display, 0x3053).decode(),
            "glVersion": get_string(0x1F02).decode(),
            "glslVersion": get_string(0x8B8C).decode(),
            "renderer": get_string(0x1F01).decode(),
            "programs": results,
            "passed": sum(result["status"] == "pass" for result in results),
            "failed": sum(result["status"] != "pass" for result in results),
            "limitation": "Native Mesa GLES compiler/linker only; not browser ANGLE validation, rendered image QA, or device compatibility testing.",
        }
        print(json.dumps(output, indent=2))
        return 1 if output["failed"] else 0
    finally:
        make_current(display, None, None, None)
        if surface:
            destroy_surface(display, surface)
        if context:
            destroy_context(display, context)
        terminate(display)


if __name__ == "__main__":
    sys.exit(main())
