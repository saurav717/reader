// This computer's Companion, as the page reaches it to do something on this
// computer: running here, paired with this browser, and new enough. Asked
// once and kept; asked again after a miss, or when told to.

import { findLocalCompanion, isNewer } from './companion';
import { allServers } from './playground';

export type ThisComputer = { server: { url: string; token: string }; id: string; name: string; version: string } | { error: string };

const asked = new Map<string, Promise<ThisComputer>>();

export function thisComputer(needs: string, what: string, again = false): Promise<ThisComputer> {
  let answer = asked.get(needs);
  if (!answer || again) {
    answer = (async (): Promise<ThisComputer> => {
      const local = await findLocalCompanion();
      if (!local?.info.id) return { error: `To ${what}, this computer’s Companion has to be running (Playground → Connect this computer).` };
      if (isNewer(needs, local.info.version)) return { error: `This computer’s Companion is ${local.info.version}; to ${what} it needs ${needs}. Update it from Your compute in the Playground.` };
      const server = allServers().find((item) => item.companionId === local.info.id && item.token);
      if (!server) return { error: 'This computer’s Companion is running but not paired with this browser yet: connect it from the Playground first.' };
      return { server, id: local.info.id, name: local.info.name, version: local.info.version };
    })();
    asked.set(needs, answer);
    void answer.then((result) => {
      if ('error' in result && asked.get(needs) === answer) asked.delete(needs);
    });
  }
  return answer;
}
