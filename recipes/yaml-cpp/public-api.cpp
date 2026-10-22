#include <yaml-cpp/yaml.h>
#include <cassert>
#include <exception>
#include <iostream>
#include <string>

int main() {
    YAML::Node root = YAML::Load("owner: engine\ndefault: &shared [1, 2, 3]\ncopy: *shared\n");
    assert(root.IsMap() && root["owner"].as<std::string>() == "engine");
    assert(root["copy"].IsSequence() && root["copy"].size() == 3);
    assert(root["copy"][1].as<int>() == 2);
    root["copy"][1] = 7;
    assert(root["default"][1].as<int>() == 7);
    YAML::Emitter emitter;
    emitter << root;
    assert(emitter.good());
    YAML::Node reparsed = YAML::Load(emitter.c_str());
    assert(reparsed["owner"].as<std::string>() == "engine");
    assert(reparsed["copy"][1].as<int>() == 7);
    bool parser_caught = false;
    try { (void)YAML::Load("[unterminated"); }
    catch (const YAML::ParserException &error) {
        parser_caught = true;
        assert(!std::string(error.what()).empty());
    }
    assert(parser_caught);
    bool conversion_caught = false;
    try { (void)root["owner"].as<int>(); }
    catch (const YAML::BadConversion &) { conversion_caught = true; }
    assert(conversion_caught);
    bool standard_caught = false;
    try { (void)YAML::Load("[unterminated"); }
    catch (const std::exception &error) {
        standard_caught = true;
        assert(!std::string(error.what()).empty());
    }
    assert(standard_caught);
    std::cout << "YAML: aliases, returned nodes/strings, emitter/reparse and external typed/base exception catches passed\n";
}
