const VENDOR = "Behringer";
const EXTENSION_NAME = "DDX3216";
const VERSION = "0.1-alpha";
const AUTHOR = "Felix Gertz";

// --- CONFIG
const MIDI_CHANNEL = 0; // 0 == channel 1. Change if your desk sends on another channel.
const NUM_FADERS = 32; // number of physical faders on the DDX3216 (visible slots)

// CC number bases (edit these to match your DDX3216 MIDI map)
const FADER_CC_BASE = 1;      // CC 1..32 -> faders 1..32
const MUTE_CC_BASE = 33;      // CC 33..64 -> mute buttons 1..32
const SELECT_CC_BASE = 65;    // CC 65..96 -> select buttons 1..32 (used to open/close groups)
const PAN_CC_BASE = 97;       // CC 97..128 -> pan knobs for channels 1..32

// Timing
const FEEDBACK_INTERVAL_MS = 200; // how often to push Bitwig state back to the desk