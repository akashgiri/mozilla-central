/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=4 sw=4 et tw=99:
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef jsion_architecture_x64_h__
#define jsion_architecture_x64_h__

#include "assembler/assembler/MacroAssembler.h"

namespace js {
namespace ion {

static const ptrdiff_t STACK_SLOT_SIZE       = 8;
static const uint32 MAX_STACK_SLOTS          = 256;
static const uint32 DOUBLE_STACK_ALIGNMENT   = 1;

// In bytes: slots needed for potential memory->memory move spills.
//   +8 for cycles
//   +8 for gpr spills
//   +8 for double spills
static const uint32 ION_FRAME_SLACK_SIZE     = 24;

#ifdef _WIN64
static const uint32 ShadowStackSpace = 32;
#else
static const uint32 ShadowStackSpace = 0;
#endif

// An offset that is illegal for a local variable's stack allocation.
static const int32 INVALID_STACK_SLOT       = -1;

class Registers {
  public:
    typedef JSC::X86Registers::RegisterID Code;

    static const char *GetName(Code code) {
        static const char *Names[] = { "rax", "rcx", "rdx", "rbx",
                                       "rsp", "rbp", "rsi", "rdi",
                                       "r8",  "r9",  "r10", "r11",
                                       "r12", "r13", "r14", "r15" };
        return Names[code];
    }

    static const Code StackPointer = JSC::X86Registers::esp;
    static const Code Invalid = JSC::X86Registers::invalid_reg;

    static const uint32 Total = 16;
    static const uint32 Allocatable = 14;

    static const uint32 AllMask = (1 << Total) - 1;

    static const uint32 ArgRegMask =
# if !defined(_WIN64)
        (1 << JSC::X86Registers::edi) |
        (1 << JSC::X86Registers::esi) |
# endif
        (1 << JSC::X86Registers::edx) |
        (1 << JSC::X86Registers::ecx) |
        (1 << JSC::X86Registers::r8) |
        (1 << JSC::X86Registers::r9);

    static const uint32 VolatileMask =
        (1 << JSC::X86Registers::eax) |
        (1 << JSC::X86Registers::ecx) |
        (1 << JSC::X86Registers::edx) |
# if !defined(_WIN64)
        (1 << JSC::X86Registers::esi) |
        (1 << JSC::X86Registers::edi) |
# endif
        (1 << JSC::X86Registers::r8) |
        (1 << JSC::X86Registers::r9) |
        (1 << JSC::X86Registers::r10) |
        (1 << JSC::X86Registers::r11);

    static const uint32 NonVolatileMask =
        (1 << JSC::X86Registers::ebx) |
#if defined(_WIN64)
        (1 << JSC::X86Registers::esi) |
        (1 << JSC::X86Registers::edi) |
#endif
        (1 << JSC::X86Registers::ebp) |
        (1 << JSC::X86Registers::r12) |
        (1 << JSC::X86Registers::r13) |
        (1 << JSC::X86Registers::r14) |
        (1 << JSC::X86Registers::r15);

    static const uint32 WrapperMask = VolatileMask;

    static const uint32 SingleByteRegs = VolatileMask | NonVolatileMask;

    static const uint32 NonAllocatableMask =
        (1 << JSC::X86Registers::esp) |
        (1 << JSC::X86Registers::r11);      // This is ScratchReg.

    // Registers that can be allocated without being saved, generally.
    static const uint32 TempMask = VolatileMask & ~NonAllocatableMask;

    static const uint32 AllocatableMask = AllMask & ~NonAllocatableMask;

    // Registers returned from a JS -> JS call.
    static const uint32 JSCallMask =
        (1 << JSC::X86Registers::ecx);

    // Registers returned from a JS -> C call.
    static const uint32 CallMask =
        (1 << JSC::X86Registers::eax);

    typedef JSC::MacroAssembler::RegisterID RegisterID;
};

// Smallest integer type that can hold a register bitmask.
typedef uint16 PackedRegisterMask;

class FloatRegisters {
  public:
    typedef JSC::X86Registers::XMMRegisterID Code;

    static const char *GetName(Code code) {
        static const char *Names[] = { "xmm0",  "xmm1",  "xmm2",  "xmm3",
                                       "xmm4",  "xmm5",  "xmm6",  "xmm7",
                                       "xmm8",  "xmm9",  "xmm10", "xmm11",
                                       "xmm12", "xmm13", "xmm14", "xmm15" };
        return Names[code];
    }

    static const Code Invalid = JSC::X86Registers::invalid_xmm;

    static const uint32 Total = 16;
    static const uint32 Allocatable = 15;

    static const uint32 AllMask = (1 << Total) - 1;

    static const uint32 VolatileMask = 
#if defined(_WIN64)
        (1 << JSC::X86Registers::xmm0) |
        (1 << JSC::X86Registers::xmm1) |
        (1 << JSC::X86Registers::xmm2) |
        (1 << JSC::X86Registers::xmm3) |
        (1 << JSC::X86Registers::xmm4) |
        (1 << JSC::X86Registers::xmm5);
#else
        AllMask;
#endif

    static const uint32 NonVolatileMask = AllMask & ~VolatileMask;

    static const uint32 WrapperMask = VolatileMask;

    static const uint32 NonAllocatableMask =
        (1 << JSC::X86Registers::xmm15);    // This is ScratchFloatReg.

    static const uint32 AllocatableMask = AllMask & ~NonAllocatableMask;
};

} // namespace ion
} // namespace js

#endif // jsion_architecture_x64_h__

