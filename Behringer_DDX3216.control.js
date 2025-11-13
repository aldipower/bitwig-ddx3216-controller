const VENDOR = "Behringer";
const EXTENSION_NAME = "DDX3216";
const VERSION = "0.7.0";
const AUTHOR = "Felix Gertz";
const DEVICE_ID = 0x7f;
const NUM_FADERS = 16 * 3;
const NUM_EFFECT_FADERS = 8; // 8 on page 4 AUX/FX
const MASTER_FADER_INDEX = 64;
const SELECT_CC_BASE = 65; // CC 65..96 -> select buttons 1..32 (used to open/close groups)
const FEEDBACK_INTERVAL_MS = 300;
const lastFaderReceiveAction = {};
const lastPanReceiveAction = {};
loadAPI(24);
host.defineController(VENDOR, EXTENSION_NAME, VERSION, "57fb8818-a6a6-4a23-9413-2a1a5aea3ce1", AUTHOR);
host.setShouldFailOnDeprecatedUse(true);
host.defineMidiPorts(1, 1);
host.addDeviceNameBasedDiscoveryPair(["DDX3216"], ["DDX3216"]);
let midiIn;
let midiOut;
let trackBank;
let effectTrackBank;
let masterTrack;
let cursorTrack;
let midiChannelSetting;
let faderValueMappingSetting;
/* Helper */
function getMidiChannel() {
    const midiChannel = midiChannelSetting.getRaw() - 1;
    return midiChannel === -1 ? undefined : midiChannel;
}
function getDeviceByte(midiChannel) {
    if (midiChannel === undefined) {
        return 0x60;
    }
    return 0x40 | (midiChannel & 0x0f);
}
function constructSysEx(command) {
    return `F0002032${getDeviceByte(getMidiChannel())
        .toString(16)
        .padStart(2, "0")}0B${command}F7`;
}
function getTrack(faderIndex) {
    return faderIndex === MASTER_FADER_INDEX
        ? masterTrack
        : faderIndex >= NUM_FADERS - 1 && faderIndex < NUM_FADERS - 1 + 16
            ? effectTrackBank.getItemAt(faderIndex - NUM_FADERS)
            : trackBank.getItemAt(faderIndex);
}
/* To DDX3216 */
// Takes and sends the sysex volume value from 0 to 1472
// ddx_dB = -80 + value/16
function sendSysExVolumeToMixer(faderIndex, sysExVolume) {
    const lastActionTimestamp = lastFaderReceiveAction[faderIndex];
    if (lastActionTimestamp != null &&
        Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp) {
        return;
    }
    const high7bit = ((sysExVolume >> 7) & 0x7f).toString(16).padStart(2, "0");
    const low7bit = (sysExVolume & 0x7f).toString(16).padStart(2, "0");
    // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX VOLUME_FUNCTION_CODE VALUE
    const command = `2001${faderIndex
        .toString(16)
        .padStart(2, "0")}01${high7bit}${low7bit}`.toUpperCase();
    const sysex = constructSysEx(command);
    midiOut.sendSysex(sysex);
}
function displayedVolumeChanged(faderIndex, bitwigDisplayValue) {
    println(`Fader vol ${faderIndex} ${bitwigDisplayValue}`);
    if (faderValueMappingSetting.get() !== "exact") {
        return;
    }
    let dbVolume = parseFloat(bitwigDisplayValue);
    const isInf = bitwigDisplayValue.includes("Inf");
    if (!isInf && isNaN(dbVolume)) {
        return;
    }
    if (dbVolume < -80 || isInf) {
        dbVolume = -80;
    }
    else if (dbVolume > 12) {
        dbVolume = 12;
    }
    const sysExVolume = Math.round((dbVolume + 80) * 16);
    sendSysExVolumeToMixer(faderIndex, sysExVolume);
}
function normalizedVolumeChanged(faderIndex, normalizedValue) {
    if (faderValueMappingSetting.get() !== "full range") {
        return;
    }
    const track = getTrack(faderIndex);
    normalizedValue = track.volume().get();
    sendSysExVolumeToMixer(faderIndex, 1472 * normalizedValue);
}
function sendSysExMuteToMixer(faderIndex, isMuted) {
    const data = isMuted ? "0001" : "0000";
    // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX MUTE_FUNCTION_CODE VALUE
    const command = `2001${faderIndex
        .toString(16)
        .padStart(2, "0")}02${data}`.toUpperCase();
    const sysex = constructSysEx(command);
    midiOut.sendSysex(sysex);
}
function panChanged(faderIndex, value) {
    const lastActionTimestamp = lastPanReceiveAction[faderIndex];
    if (lastActionTimestamp != null &&
        Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp) {
        return;
    }
    const sysexValue = 30 + Math.round(value * 30);
    const high7bit = ((sysexValue >> 7) & 0x7f).toString(16).padStart(2, "0");
    const low7bit = (sysexValue & 0x7f).toString(16).padStart(2, "0");
    // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX MUTE_FUNCTION_CODE VALUE
    const command = `2001${faderIndex
        .toString(16)
        .padStart(2, "0")}03${high7bit}${low7bit}`.toUpperCase();
    println(`pan changed s ${sysexValue}`);
    const sysex = constructSysEx(command);
    midiOut.sendSysex(sysex);
}
/* From DDX3216 */
function dbToNormalized(db) {
    if (db <= -80.0) {
        return 0;
    }
    if (db >= 6.0) {
        return 1;
    }
    return Math.pow(10, (db - 6) / 60);
}
function setBitwigFaderVolumeBySysexValue(faderIndex, sysexVolume, settingsFaderValueMapping) {
    try {
        const track = getTrack(faderIndex);
        let normalizedVolume;
        if (settingsFaderValueMapping === "exact") {
            const dbValue = sysexVolume / 16 - 80;
            normalizedVolume = dbToNormalized(dbValue);
        }
        else {
            normalizedVolume = sysexVolume / 1472;
        }
        track.volume().setImmediately(normalizedVolume);
        lastFaderReceiveAction[faderIndex] = Date.now();
    }
    catch (error) {
        host.errorln(`Could not set Bitwig fader volume by sysex ${error}`);
    }
}
function setBitwigTrackMute(faderIndex, isMuted) {
    const track = getTrack(faderIndex);
    track.mute().set(isMuted);
}
function setBitwigFaderPanBySysexValue(faderIndex, sysexPan) {
    try {
        const track = getTrack(faderIndex);
        const panValue = -1 + sysexPan / 30;
        track.pan().setRaw(panValue);
        lastPanReceiveAction[faderIndex] = Date.now();
    }
    catch (error) {
        host.errorln(`Could not set Bitwig fader pan by sysex ${error}`);
    }
}
function selectBitwigFaderAndCloseOpenGroup(faderIndex, groupIsOpen) {
    const track = trackBank.getItemAt(faderIndex);
    track.selectInEditor();
    if (track.isGroup()) {
        track.isGroupExpanded().set(groupIsOpen);
    }
}
/* General control functions */
function processIncomingSysex(sysexData) {
    const settingsMidiChannel = getMidiChannel();
    const settingsFaderValueMapping = faderValueMappingSetting.get();
    const regexp = /f0002032([0-F]{2})0b([0-F]{2})([0-F]{2})(.*)F7/gim;
    const [, midiChannel, functionType, msgCount, messagesString] = regexp.exec(sysexData);
    const messages = messagesString.match(/.{1,8}/g);
    if (settingsMidiChannel !== undefined &&
        parseInt(midiChannel, 16) !== settingsMidiChannel) {
        println(`Incoming midi channel ${parseInt(midiChannel, 16) + 1} does not match set channel ${settingsMidiChannel + 1}.`);
        return;
    }
    println(`Midi Channel: ${midiChannel} fnType: ${functionType} msgCount: ${msgCount} messages: ${messages.join("|")}`);
    if (parseInt(msgCount, 16) !== messages.length) {
        host.errorln(`Message count does not match messages length`);
    }
    // Function: Parameter change
    if (functionType === "20") {
        if (messages == null) {
            host.errorln("messages is null");
            return;
        }
        messages.forEach((message, i) => {
            if (message == null) {
                host.errorln("message is null");
                return;
            }
            const paramRegex = /([0-F]{2})([0-F]{2})([0-F]{2})([0-F]{2})/gim;
            const [, faderIndex, functionCode, highWord, lowWord] = paramRegex.exec(message);
            let sysexValue = Number((parseInt(highWord, 16) << 7) | parseInt(lowWord, 16));
            println(`faderIndex: ${faderIndex} fnCode: ${functionCode} highWord: ${highWord} lowWord: ${lowWord} sysexValue: ${sysexValue}`);
            if (isNaN(sysexValue)) {
                return;
            }
            const faderIndexInt = parseInt(faderIndex, 16);
            // Volume
            if (functionCode === "01") {
                setBitwigFaderVolumeBySysexValue(faderIndexInt, sysexValue, settingsFaderValueMapping);
                // Mute
            }
            else if (functionCode === "02") {
                setBitwigTrackMute(faderIndexInt, !!sysexValue);
                // Pan
            }
            else if (functionCode === "03") {
                setBitwigFaderPanBySysexValue(faderIndexInt, sysexValue);
                // Select track and close/open group
            }
            else if (functionCode === "04") {
                selectBitwigFaderAndCloseOpenGroup(faderIndexInt, !sysexValue);
            }
        });
    }
}
function createBitwigSettingsUI() {
    midiChannelSetting = host
        .getPreferences()
        .getNumberSetting("MIDI channel (0 = omni)", "Connection", 0, 16, 1, "", 1);
    faderValueMappingSetting = host
        .getPreferences()
        .getEnumSetting("dB mapping", "Fader", ["exact", "full range"], "exact");
    host
        .getPreferences()
        .getStringSetting("Developed by Felix Gertz", "Support", 128, "Support me via https://aldipower.bandcamp.com/album/das-reihenhaus and purchase the album. Thank you so much.");
}
function registerObserver() {
    for (let i = 0; i < NUM_FADERS; i++) {
        const t = trackBank.getItemAt(i);
        t.volume().markInterested();
        t.pan().markInterested();
        t.mute().markInterested();
        t.isGroupExpanded().markInterested();
        t.volume()
            .displayedValue()
            .addValueObserver((displayedValue) => {
            displayedVolumeChanged(i, displayedValue);
        });
        t.volume()
            .value()
            .addRawValueObserver((value) => {
            normalizedVolumeChanged(i, value);
        });
        t.pan()
            .value()
            .addRawValueObserver((value) => {
            panChanged(i, value);
        });
        t.mute().addValueObserver((isMuted) => {
            sendSysExMuteToMixer(i, isMuted);
        });
    }
    // Effect faders
    for (let i = 0; i < NUM_EFFECT_FADERS; i++) {
        const t = effectTrackBank.getItemAt(i);
        t.volume().markInterested();
        t.pan().markInterested();
        t.mute().markInterested();
        t.volume()
            .displayedValue()
            .addValueObserver((displayedValue) => {
            displayedVolumeChanged(NUM_FADERS + i, displayedValue);
        });
        t.volume()
            .value()
            .addRawValueObserver((value) => {
            normalizedVolumeChanged(NUM_FADERS + i, value);
        });
        t.pan()
            .value()
            .addRawValueObserver((value) => {
            panChanged(NUM_FADERS + i, value);
        });
        t.mute().addValueObserver((isMuted) => {
            sendSysExMuteToMixer(NUM_FADERS + i, isMuted);
        });
    }
    masterTrack.volume().markInterested();
    masterTrack
        .volume()
        .displayedValue()
        .addValueObserver((displayedValue) => {
        displayedVolumeChanged(MASTER_FADER_INDEX, displayedValue);
    });
    masterTrack
        .volume()
        .value()
        .addRawValueObserver((value) => {
        normalizedVolumeChanged(MASTER_FADER_INDEX, value);
    });
    masterTrack.pan().markInterested();
    masterTrack
        .pan()
        .value()
        .addRawValueObserver((value) => {
        panChanged(MASTER_FADER_INDEX, value);
    });
}
function init() {
    createBitwigSettingsUI();
    midiIn = host.getMidiInPort(0);
    midiOut = host.getMidiOutPort(0);
    trackBank = host.createMainTrackBank(NUM_FADERS, 0, 0);
    effectTrackBank = host.createEffectTrackBank(8, 0, 0);
    masterTrack = host.createMasterTrack(0);
    cursorTrack = host.createCursorTrack("cursor", "Cursor Track", 0, 0, true);
    // TODO: Create proper scrolling to selected tracks
    // trackBank = cursorTrack.createSiblingsTrackBank(NUM_FADERS, 0, 0, true, true);
    // trackBank.cursorIndex().markInterested();
    registerObserver();
    midiIn.setSysexCallback((sysexData) => {
        println(`Sysex received ${sysexData} midiChannelSetting: ${midiChannelSetting.getRaw()}`);
        if (!sysexData.startsWith("f0002032")) {
            return;
        }
        processIncomingSysex(sysexData);
    });
    println(`${VENDOR} ${EXTENSION_NAME} controller script version ${VERSION} written by ${AUTHOR} initialized. This script comes under GPLv3 license.`);
}
// TODO: All faders
function exit() {
    for (let i = 0; i < NUM_FADERS; i++) {
        displayedVolumeChanged(i, "-80");
    }
}
function flush() { }
