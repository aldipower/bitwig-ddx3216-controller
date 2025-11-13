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

// --- Helpers
function ccToIndex(controller, base) {
  return controller - base; // zero-based index
}

// --- Bitwig Host init
loadAPI(19);
host.defineController(VENDOR, EXTENSION_NAME, VERSION, "57fb8818-a6a6-4a23-9413-2a1a5aea3ce1", AUTHOR);
host.setShouldFailOnDeprecatedUse(true);
host.defineMidiPorts(1, 1);
host.addDeviceNameBasedDiscoveryPair(["DDX3216"], ["DDX3216"]);

let midiIn;
let midiOut;
let trackBank;
let cursorTrack;

// Keep mapping of which Bitwig track corresponds to each physical fader index
// Initially it is the trackBank items, but changes when the user scrolls / opens groups
function getVisibleTrackAt(faderIndex) {
    return trackBank.getItemAt(faderIndex);
}

// Update mapping when the mixer view changes (groups open/close, etc.)
// Many Bitwig APIs provide listeners/callbacks when trackBank content changes; we create a periodic poll
function refreshVisibleMapping() {
    // No-op here because trackBank.getItemAt always reflects the current visible slots.
    // But we keep this function to perform any bookkeeping if needed.
}

// --- Core behavior: opening/closing groups on Select
// The Select button is used to open/close a group track if that fader corresponds to a group.
// When a group is opened, the visible tracks in Bitwig update automatically; the script then
// sends the new volumes/mute/pan to the DDX so the desk reflects the newly visible tracks.

function handleSelectPress(index) {
    if (index < 0 || index >= NUM_FADERS) return;
    const track = getVisibleTrackAt(index);
    if (!track) return;

    // Determine whether this track is a group/has children. Different typed-bitwig-api versions
    // may expose different methods. We try multiple common possibilities and fallback gracefully.
    try {
        // Common method variants that might exist:
        // - track.getIsGroup() -> boolean
        // - track.isExpanded() / track.isCollapsed()
        // - track.getIsFolded() etc.

        // 1) If API offers toggleFold or setIsFolded / setFolded, use that
        // @ts-ignore
        if (typeof track.toggleFold === 'function') {
            // @ts-ignore
            track.toggleFold();
            postSelectUpdate();
            return;
        }

        // 2) If API offers setFoldState / setCollapsed
        // @ts-ignore
        if (typeof track.setCollapsed === 'function') {
            // @ts-ignore
            const cur = track.isCollapsed ? track.isCollapsed() : (track.getIsCollapsed && track.getIsCollapsed());
            // @ts-ignore
            track.setCollapsed(!cur);
            postSelectUpdate();
            return;
        }

        // 3) If API offers expand/collapse directly
        // @ts-ignore
        if (typeof track.expand === 'function' && typeof track.collapse === 'function') {
            // @ts-ignore
            if (track.isExpanded && typeof track.isExpanded === 'function' ? track.isExpanded() : true) {
                // @ts-ignore
                track.collapse();
            } else {
                // @ts-ignore
                track.expand();
            }
            postSelectUpdate();
            return;
        }

        // 4) If none of the above are present, maybe the typed API exposes a group-specific API on the project/arranger.
        // We'll try a best-effort: check if the track has a boolean "isGroup" and a "folded" property.
        // @ts-ignore
        const isGroup = (typeof track.getIsGroup === 'function' && track.getIsGroup()) || (track.type && track.type.get && track.type.get() === 'Group');
        if (!isGroup) {
            // Not a group track — instead treat select as simply selecting the track
            trySelectTrack(track);
            return;
        }

        // Fallback: if it's a group but we can't programmatically toggle fold, open a UI hint
        println('This Bitwig API version does not provide a method to open/close groups programmatically.');
        trySelectTrack(track);
    } catch (e) {
        println('handleSelectPress error: ' + e);
    }
}

function trySelectTrack(track) {
    // Attempt to select the track in the editor or mixer; this often updates Bitwig's visible area
    try {
        if (typeof track.select === 'function') {
            track.select();
        } else if (typeof cursorTrack.selectInEditor === 'function') {
            cursorTrack.selectInEditor();
        } else if (typeof host.showPopupNotification === 'function') {
            host.showPopupNotification('Select not available on this API version.');
        }
    } catch (e) {
        // ignore
    }
}

// After toggling a group's open/close state, call this to refresh and send the new visible state to the desk
function postSelectUpdate() {
    // Small delay to allow Bitwig to update the visible tracks
    host.scheduleTask(() => {
        refreshVisibleMapping();
        // Push current visible volumes/mutes/pans to the DDX so the faders/LEDs reflect the view
        for (let i = 0; i < NUM_FADERS; i++) sendFeedbackForFader(i);
    }, 50);
}

// --- CC handling
function handleCC(cc, val) {
    // Faders
    if (cc >= FADER_CC_BASE && cc < FADER_CC_BASE + NUM_FADERS) {
        const idx = ccToIndex(cc, FADER_CC_BASE);
        setTrackVolumeFromCC(idx, val);
        return;
    }

    // Mutes
    // if (cc >= MUTE_CC_BASE && cc < MUTE_CC_BASE + NUM_FADERS) {
    //     const idx = ccToIndex(cc, MUTE_CC_BASE);
    //     setTrackMuteFromCC(idx, val);
    //     return;
    // }

    // // Select (open/close group)
    // if (cc >= SELECT_CC_BASE && cc < SELECT_CC_BASE + NUM_FADERS) {
    //     const idx = ccToIndex(cc, SELECT_CC_BASE);
    //     if (val > 0) handleSelectPress(idx);
    //     return;
    // }

    // // Pan
    // if (cc >= PAN_CC_BASE && cc < PAN_CC_BASE + NUM_FADERS) {
    //     const idx = ccToIndex(cc, PAN_CC_BASE);
    //     setTrackPanFromCC(idx, val);
    //     return;
    // }
}

// --- Actions: set volume/mute/pan on the visible track corresponding to a fader index
function setTrackVolumeFromCC(faderIndex, ccValue) {
    const track = getVisibleTrackAt(faderIndex);
    if (!track) return;
    const norm = ccValue / 127.0; // 0..1

    println(`${ccValue} ${norm}`)
    try {
        track.volume().value().set(norm);
    } catch (e) {
        println(`error setTrackVolumeFromCC ${e}`)
        // fallback: if API uses setRawValue
        // if (track.getVolume && track.getVolume().setRawValue) {
        //     // @ts-ignore
        //     track.getVolume().setRawValue(norm);
        // }
    }
}

function setTrackMuteFromCC(faderIndex, ccValue) {
    const track = getVisibleTrackAt(faderIndex);
    if (!track) return;
    const isOn = ccValue >= 64;
    try {
        const mute = track.getMute();
        if (typeof mute.set === 'function') {
            mute.set(isOn);
        } else if (typeof mute.toggle === 'function' && isOn) {
            mute.toggle();
        }
    } catch (e) {
        println('setTrackMuteFromCC error: ' + e);
    }
}

function setTrackPanFromCC(faderIndex, ccValue) {
    const track = getVisibleTrackAt(faderIndex);
    if (!track) return;
    // convert 0..127 -> -1..1 (Bitwig pan often uses -1..1 or 0..1 depending on API)
    const norm = (ccValue / 127.0) * 2 - 1;
    try {
        track.getPan().set(norm, 0);
    } catch (e) {
        // fallback if pan expects 0..1
        try {
            track.getPan().set((norm + 1) / 2, 0);
        } catch (e2) {
            // ignore
        }
    }
}

function sendVolumeChangeToMixer(faderIndex) {
  const track = getVisibleTrackAt(faderIndex);

  const ddxMin = -74;
  const ddxMax = 12;
  
  // At 24bit
  const bitwigMin = -132;
  const bitwigMax = 6;

  function mapBitwigDbToDdxDb(bitwigDb) {
    return ((bitwigDb - bitwigMin) / (bitwigMax - bitwigMin)) * (ddxMax - ddxMin) + ddxMin;
  }
  
  // Map DDX dB -> MIDI CC 0..127
  function ddxDbToCc(ddxDb) {
    const cc = Math.round(((ddxDb - ddxMin) / (ddxMax - ddxMin)) * 127);
    return Math.max(0, Math.min(127, cc));
  }

  try {
    const vol = track.volume().get();
    // const volDb = track.volume().displayedValue().get();
    // const volDb = vol * (bitwigMax - bitwigMin) + bitwigMin;
    // const ddxDb = mapBitwigDbToDdxDb(volDb);
    // const ccVal = ddxDbToCc(volDb);
    const ccVal = Math.max(0, Math.min(127, Math.round((vol || 0) * 127)));

    host.println(` Volume ${vol} ${ccVal}`) //  ${volDb}

    midiOut.sendMidi(0xB0 | MIDI_CHANNEL, FADER_CC_BASE + faderIndex, ccVal);
  } catch (e) {
    host.errorln(`volume error: ${e}`);
  }
}

// --- Feedback: send Bitwig state to the DDX3216 so the physical desk follows Bitwig's visible tracks
function sendFeedbackForFader(faderIndex) {
    const track = getVisibleTrackAt(faderIndex);
    if (!track) return;

    // Volume
    sendVolumeChangeToMixer(faderIndex);

    // Mute
    // try {
    //     const muteParam = track.mute().get();
    //     const isMuted = (muteParam && typeof muteParam.get === 'function') ? !!muteParam.get() : false;
    //     midiOut.sendMidi(0xB0 | MIDI_CHANNEL, MUTE_CC_BASE + faderIndex, isMuted ? 127 : 0);
    // } catch (e) {
    //     host.errorln(`mute error: ${e}`);
    // }

    // // Pan
    // try {
    //     const panParam = track.pan().get();
    //     // Some APIs return -1..1, some 0..1. We'll try to normalize.
    //     let panVal = 0.5;
    //     if (panParam && typeof panParam.get === 'function') {
    //         panVal = panParam.get();
    //         if (panVal <= 1 && panVal >= -1) {
    //             // convert -1..1 to 0..127
    //             const ccVal = Math.round(((panVal + 1) / 2) * 127);
    //             midiOut.sendMidi(0xB0 | MIDI_CHANNEL, PAN_CC_BASE + faderIndex, ccVal);
    //         } else if (panVal >= 0 && panVal <= 1) {
    //             const ccVal = Math.round(panVal * 127);
    //             midiOut.sendMidi(0xB0 | MIDI_CHANNEL, PAN_CC_BASE + faderIndex, ccVal);
    //         }
    //     }
    // } catch (e) {
    //   host.errorln(`pan error: ${e}`);
    // }
}

function init() {
  midiIn = host.getMidiInPort(0);
  midiOut = host.getMidiOutPort(0);
  
  midiIn.setMidiCallback((status, data1, data2) => {
    const msgType = status & 0xf0;
    const chan = status & 0x0f;
    if (chan !== MIDI_CHANNEL) return; // ignore other channels unless omni desired

    if (msgType === 0xB0) { // Control Change
        const cc = data1;
        const val = data2;
        handleCC(cc, val);
    }
    // SysEx could be handled here for higher resolution faders if you implement it
  });
  
  // Create a track bank representing the visible area of the mixer
  trackBank = host.createMainTrackBank(NUM_FADERS, 0, 0);
  // Keep a cursor for global navigation/selection actions
  cursorTrack = host.createCursorTrack(0, 0);

  // Enable parameter indication for feedback
  for (let i = 0; i < NUM_FADERS; i++) {
    const t = trackBank.getItemAt(i);
    t.volume().setIndication(true);
    t.volume().markInterested();
    t.pan().setIndication(true);
    t.pan().markInterested();
    t.mute().markInterested();

    t.volume().value().addValueObserver(() => {
      sendVolumeChangeToMixer(i);
    });
  }

  // Periodic task to refresh visible mapping and push feedback
  host.scheduleTask(() => {
    refreshVisibleMapping();
    for (let i = 0; i < NUM_FADERS; i++) sendFeedbackForFader(i);
  }, FEEDBACK_INTERVAL_MS);

  println(`${VENDOR} ${EXTENSION_NAME} controller script version ${VERSION} written by ${AUTHOR} initialized. This script comes under GPLv3 license.`);
}

function exit() {
    
}