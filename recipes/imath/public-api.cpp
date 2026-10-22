#include <Imath/half.h>
#include <cassert>
#include <cmath>
#include <iostream>
#include <sstream>

int main() {
    assert(imath_half_to_float_table);
    assert(imath_half_to_float_table[0x3e00].f == 1.5f);
    assert(imath_half_to_float_table[0xc000].f == -2.0f);
    Imath::half value(1.5f);
    assert(value.bits() == 0x3e00 && float(value) == 1.5f);
    std::stringstream output;
    output << value;
    assert(output.str() == "1.5");
    std::stringstream input("-2.25");
    input >> value;
    assert(input && float(value) == -2.25f);
    Imath::half bits_value(1.5f);
    char half_bits[19], float_bits[35];
    printBits(half_bits, bits_value);
    printBits(float_bits, 1.5f);
    std::stringstream half_stream, float_stream;
    printBits(half_stream, bits_value);
    printBits(float_stream, 1.5f);
    assert(std::string(half_bits) == "0 01111 1000000000");
    assert(std::string(float_bits) == "0 01111111 10000000000000000000000");
    assert(half_stream.str() == half_bits && float_stream.str() == float_bits);
    value.setBits(0x7c00);
    assert(value.isInfinity() && std::isinf(float(value)));
    value.setBits(0x7e00);
    assert(value.isNan() && std::isnan(float(value)));
    std::cout << "Imath: exported half table, compiled stream operators, all four global printBits overloads, roundtrip and special values passed\n";
}
