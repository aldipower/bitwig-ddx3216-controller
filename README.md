Be an Uli and use Bitwig like a pro with the Behringer DDX3216 controller script!

### Highlights

* Exact dB fader mapping! -10dB in Bitwig is -10dB on the DDX3216 and so on.
* High fader resolution of 1427 steps via SysEx.
* Open and close Bitwig groups.
* Bidirectional behaviour. Your motor faders will dance! Changes in Bitwig reflect on the DDX3216 vice versa.

### Features

* Volume faders on 1-48
* Effect track faders on 49-56 by selecting the AUX/FX page, reflecting the Bitwig FX tracks.
* Channels 57-64 can be used as a spare for something else.
* Master fader
* Panning on 1-32 and the master
* Mutes on all channels except master
* 8 sends on each channel by pressing the AUX1-4/FX1-4 buttons reflecting the Bitwig sends.
* Select a channel in Bitwig by pressing SELECT -> ROUTING -> MAIN (the select button itself does not receive/send any SysEx/CC)
* Open/close a group in Bitwig also by pressing SELECT -> ROUTING -> MAIN. The MAIN icon indicates the group status.

### Configration

* Set the MIDI channel in the controller script config dialog in Bitwig. 0 = omni
* Fader dB mapping behaviour is choosable between "exact" or "full range" in the config dialog. default = "exact"

### Installation

1. Simply copy the `Behringer_DDX3216.control.js` file out of the project root folder into your Bitwig `~/Bitwig Studio/Controller Scripts` folder. No need to create a sub-folder.
2. Add the controller script in Bitwig by choosing "Behringer -> DDX3216" in `Settings` and `Controller`.
3. Select the appropiate MIDI ports in the config dialog and also check/adjust the MIDI channel.
4. On the DDX3216 check for matching MIDI channels by pressing MMC/MIDI -> SETUP -> Transmit/Receive Channel.
5. On the DDX3216 check if `Direct Parameter SysEx` is enabled by pressing MMC/MIDI -> SETUP -> RX/TX.

### ToDo - Things I would like to have

* Make the EQ, Gate and Comp working. In both directions!

### Not so nice, but also not deadly.

* Effect tracks embedded in groups are not accessible due to Bitwig's API behaviour.
* No solo buttons: The DDX3216 has no Sysex or CC implementation for the solo buttons, so they simply do not work.
* No pan at bus, aux and FX faders: Faders 33-64 are not panable, due to the lack of Sysex or CC commands. Did they ran out of memory or what?

### Support me

If you enjoy the script, please purchase my music album on Bandcamp. It's also released on tape as cassette!
[AldiPower on Bandcamp](https://aldipower.bandcamp.com/album/das-reihenhaus)
Thank you so much.

### Contribute

Create an issues or better a PR here on GitHub, if you have something to fix or add.

### Credits & Disclaimer

Thanks to the guys of [Typed Bitwig Api](https://github.com/joslarson/typed-bitwig-api), especially [Joseph Larson](https://github.com/joslarson), who made it possible to access the Bitwig API via TypeScript. Fantastic!

I am not work for Behringer nor did I wrote this script for commerical interests. I am not liable if your motor faders start to burn.
