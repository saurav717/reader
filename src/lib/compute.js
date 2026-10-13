// Turning compute on and off (types.ts, `COMPUTE_CONTROLS`). Off is a list in
// Settings of the places to run that are left out of every choice of where to
// run: 'colab', or a server's id. A server is known by its Companion's id when
// it has one, as that stays the same when its address changes; else by its id
// in this browser. Nothing here starts or stops a machine: that is the
// Companion's and Colab's (src/lib/companion.ts, src/lib/colab.ts).
import { COMPUTE_CONTROLS } from '../types';
export const COLAB = 'colab';
/** The id a server is turned off by. */
export const computeId = (server) => server.companionId || server.id;
/** Whether a place to run is on: not in the list of those turned off. */
export const isOn = (settings, id) => !(Array.isArray(settings.computeOff) && settings.computeOff.includes(id));
/** The list with a place turned on or off. */
export function switched(off, id, on) {
    const without = (Array.isArray(off) ? off : []).filter((item) => item !== id);
    return on ? without : [...without, id];
}
/** The servers that are on; `keep` stays whatever its switch, for a playground already on it. */
export const serversOn = (settings, servers, keep) => servers.filter((server) => server.id === keep || isOn(settings, computeId(server)));
/** The choice in Settings, as it can be relied on: the default for anything else. */
export const computeControlsOf = (settings) => COMPUTE_CONTROLS.some((option) => option.id === settings.computeControls) ? settings.computeControls : 'everywhere';
/** Whether the switches show where code is set up. */
export const switchesOnCards = (settings) => ['everywhere', 'cards'].includes(computeControlsOf(settings));
/** Whether the rail has the compute chip. */
export const chipInRail = (settings) => ['everywhere', 'rail'].includes(computeControlsOf(settings));
