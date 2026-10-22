import ctypes
import sys

library = ctypes.CDLL("libzmq.so.5")
library.zmq_ctx_new.restype = ctypes.c_void_p
library.zmq_socket.argtypes = [ctypes.c_void_p, ctypes.c_int]
library.zmq_socket.restype = ctypes.c_void_p
library.zmq_setsockopt.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t]
library.zmq_connect.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
library.zmq_send.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
library.zmq_recv.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
library.zmq_close.argtypes = [ctypes.c_void_p]
library.zmq_ctx_term.argtypes = [ctypes.c_void_p]
context = library.zmq_ctx_new()
assert context
socket = library.zmq_socket(context, 3)  # ZMQ_REQ
assert socket
try:
    timeout = ctypes.c_int(5000)
    for option in (27, 28):  # ZMQ_RCVTIMEO, ZMQ_SNDTIMEO
        assert library.zmq_setsockopt(socket, option, ctypes.byref(timeout), ctypes.sizeof(timeout)) == 0
    linger = ctypes.c_int(0)
    assert library.zmq_setsockopt(socket, 17, ctypes.byref(linger), ctypes.sizeof(linger)) == 0
    assert library.zmq_connect(socket, b"tcp://127.0.0.1:5555") == 0
    command = b"volume@ffb volume 0.5"
    assert library.zmq_send(socket, command, len(command), 0) == len(command)
    response = ctypes.create_string_buffer(1024)
    size = library.zmq_recv(socket, response, len(response), 0)
    assert size > 0
    answer = response.raw[:size].decode()
    assert answer.startswith("0 Success"), answer
    print(answer)
finally:
    assert library.zmq_close(socket) == 0
    assert library.zmq_ctx_term(context) == 0
