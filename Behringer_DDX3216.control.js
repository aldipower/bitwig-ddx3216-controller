var VENDOR = "Behringer";
var EXTENSION_NAME = "DDX3216";
var VERSION = "0.1-alpha";
var AUTHOR = "Felix Gertz";
// --- CONFIG
var MIDI_CHANNEL = 0; // 0 == channel 1. Change if your desk sends on another channel.
var NUM_FADERS = 32; // number of physical faders on the DDX3216 (visible slots)
// CC number bases (edit these to match your DDX3216 MIDI map)
var FADER_CC_BASE = 1; // CC 1..32 -> faders 1..32
var MUTE_CC_BASE = 33; // CC 33..64 -> mute buttons 1..32
var SELECT_CC_BASE = 65; // CC 65..96 -> select buttons 1..32 (used to open/close groups)
var PAN_CC_BASE = 97; // CC 97..128 -> pan knobs for channels 1..32
// Timing
var FEEDBACK_INTERVAL_MS = 200; // how often to push Bitwig state back to the desk
