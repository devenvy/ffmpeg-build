.text
.macro caller name, adjustment
.globl \name
.type \name, @function
\name:
    push %rbp
    mov %rsp, %rbp
    and $-32, %rsp
    sub $\adjustment, %rsp
    mov $32, %edx
    xor %ecx, %ecx
    mov $32, %r8d
    mov $32, %r9d
    call davs2_intra_pred_bilinear_avx
    mov %rbp, %rsp
    pop %rbp
    ret
.size \name, .-\name
.endm
caller ffb_davs2_call16, 16
caller ffb_davs2_call32, 0
.section .note.GNU-stack,"",@progbits
