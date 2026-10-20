/**
 * What each simulator in the picker (src/components/SimPicker.tsx) looks like: a short clip or picture from its own
 * documentation or repository, shown beside its details. Every address was fetched and checked to be the media it
 * says; one that stops working shows a "no preview" box, never a broken image. Picking an environment shows that
 * environment's own clip when it has one (most do), so the scene can be seen before it is chosen; one without shows the
 * simulator's, marked as such.
 */

export interface SimPreview {
  url: string;
  kind: 'gif' | 'video' | 'image';
  /** Whose it is: "Gymnasium docs". */
  credit?: string;
  /** The page it comes from. */
  page?: string;
  /** It shows the environment asked about, not the simulator in general. */
  own?: boolean;
  /** What to know about it, said on it: "the real robot, not the simulation". */
  note?: string;
  /** Its size, when it is big enough to wait for a click (HEAVY). */
  bytes?: number;
}

/** Clips at least this big load when asked for, not as the environment is picked. */
export const HEAVY = 15_000_000;

const SIMS: Record<string, SimPreview> = {
  gymnasium: { url: 'https://gymnasium.farama.org/_images/cart_pole.gif', kind: 'gif', credit: 'Gymnasium docs', page: 'https://gymnasium.farama.org/environments/classic_control/cart_pole/' },
  box2d: { url: 'https://gymnasium.farama.org/_images/lunar_lander.gif', kind: 'gif', credit: 'Gymnasium docs', page: 'https://gymnasium.farama.org/environments/box2d/lunar_lander/' },
  mujoco: { url: 'https://gymnasium.farama.org/_images/half_cheetah.gif', kind: 'gif', credit: 'Gymnasium docs', page: 'https://gymnasium.farama.org/environments/mujoco/half_cheetah/' },
  dm_control: { url: 'https://raw.githubusercontent.com/google-deepmind/dm_control/main/dm_control/suite/all_domains.png', kind: 'image', credit: 'dm_control GitHub', page: 'https://github.com/google-deepmind/dm_control/tree/main/dm_control/suite' },
  mujoco_playground: { url: 'https://raw.githubusercontent.com/google-deepmind/mujoco_playground/main/assets/banner.png', kind: 'image', credit: 'MuJoCo Playground GitHub', page: 'https://github.com/google-deepmind/mujoco_playground' },
  brax: { url: 'https://raw.githubusercontent.com/google/brax/main/docs/img/ant_v2.gif', kind: 'gif', credit: 'Brax GitHub', page: 'https://github.com/google/brax' },
  gymnasium_robotics: { url: 'https://robotics.farama.org/_images/pick_and_place.gif', kind: 'gif', credit: 'Gymnasium-Robotics docs', page: 'https://robotics.farama.org/' },
  myosuite: { url: 'https://myosuite.readthedocs.io/en/latest/_images/hand_baoding_balls.png', kind: 'image', credit: 'MyoSuite docs', page: 'https://myosuite.readthedocs.io/en/latest/suite.html' },
  metaworld: { url: 'https://metaworld.farama.org/_images/mt1.gif', kind: 'gif', credit: 'Meta-World docs', page: 'https://metaworld.farama.org/benchmark/benchmark_descriptions/' },
  robosuite: { url: 'https://raw.githubusercontent.com/ARISE-Initiative/robosuite/master/docs/images/gallery.png', kind: 'image', credit: 'robosuite GitHub', page: 'https://github.com/ARISE-Initiative/robosuite' },
  maniskill: { url: 'https://raw.githubusercontent.com/haosulab/ManiSkill/main/figures/teaser.jpg', kind: 'image', credit: 'ManiSkill GitHub', page: 'https://github.com/haosulab/ManiSkill' },
  genesis: { url: 'https://raw.githubusercontent.com/Genesis-Embodied-AI/genesis-world/readme-assets/videos/HeroShot_Final.png', kind: 'image', credit: 'Genesis GitHub', page: 'https://github.com/Genesis-Embodied-AI/Genesis' },
  pybullet: { url: 'https://lh4.googleusercontent.com/242hgiiYPdadrTaz_QESJMhxNUSyTJunbN0MkqGEC64OFh4JqCELfeLgFPVLlr8SMOn6xgx7Q3jDw6v9t8zjR6n-prG1Z9BkTeF7tMPSkR_yGJJBMFVUuH2Xr9_b71HSFoRHXQNjkg', kind: 'gif', credit: 'pybullet.org', page: 'https://pybullet.org/' },
  isaaclab: { url: 'https://raw.githubusercontent.com/isaac-sim/IsaacLab/main/docs/source/_static/isaaclab.jpg', kind: 'image', credit: 'Isaac Lab GitHub', page: 'https://github.com/isaac-sim/IsaacLab' },
  drake: { url: 'https://user-images.githubusercontent.com/26719449/108152577-4d14f300-70a7-11eb-88c5-5da0c39b1e24.mp4', kind: 'video', credit: 'Drake website', page: 'https://drake.mit.edu/' },
  ale: { url: 'https://ale.farama.org/_images/breakout.gif', kind: 'gif', credit: 'ALE docs', page: 'https://ale.farama.org/environments/breakout/' },
  minigrid: { url: 'https://minigrid.farama.org/_images/door-key-curriculum.gif', kind: 'gif', credit: 'MiniGrid docs', page: 'https://minigrid.farama.org/' },
  crafter: { url: 'https://danijar.com/asset/crafter/video.mp4', kind: 'video', credit: 'Crafter project page (danijar.com)', page: 'https://danijar.com/project/crafter/' },
  craftax: { url: 'https://raw.githubusercontent.com/MichaelTMatthews/Craftax/main/images/dungeon_crawling.gif', kind: 'gif', credit: 'Craftax GitHub', page: 'https://github.com/MichaelTMatthews/Craftax' },
  gymnax: { url: 'https://raw.githubusercontent.com/RobertTLange/gymnax/main/docs/anim.gif', kind: 'gif', credit: 'gymnax GitHub', page: 'https://github.com/RobertTLange/gymnax' },
  vizdoom: { url: 'https://raw.githubusercontent.com/Farama-Foundation/ViZDoom/main/docs/_static/img/vizdoom-demo.gif', kind: 'gif', credit: 'ViZDoom GitHub', page: 'https://github.com/Farama-Foundation/ViZDoom' },
  nle: { url: 'https://raw.githubusercontent.com/heiner/nle/main/dat/nle/example_run.gif', kind: 'gif', credit: 'NLE GitHub', page: 'https://github.com/heiner/nle' },
  minerl: { url: 'https://minerl.readthedocs.io/en/latest/_images/survival1.mp4.gif', kind: 'gif', credit: 'MineRL docs', page: 'https://minerl.readthedocs.io/en/latest/' },
  mlagents: { url: 'https://raw.githubusercontent.com/Unity-Technologies/ml-agents/develop/docs/images/image-banner.png', kind: 'image', credit: 'Unity ML-Agents GitHub', page: 'https://github.com/Unity-Technologies/ml-agents' },
  godot_rl: { url: 'https://raw.githubusercontent.com/edbeeching/godot_rl_agents/main/docs/all_example_envs.png', kind: 'image', credit: 'Godot RL Agents GitHub', page: 'https://github.com/edbeeching/godot_rl_agents/blob/main/docs/EXAMPLE_ENVIRONMENTS.md' },
  habitat: { url: 'https://user-images.githubusercontent.com/2941091/126080914-36dc8045-01d4-4a68-8c2e-74d0bca1b9b8.mp4', kind: 'video', credit: 'Habitat-Sim GitHub', page: 'https://github.com/facebookresearch/habitat-sim' },
  pettingzoo: { url: 'https://pettingzoo.farama.org/_images/environments-demo.gif', kind: 'gif', credit: 'PettingZoo docs', page: 'https://pettingzoo.farama.org/' },
  highway_env: { url: 'https://highway-env.farama.org/_images/highway.gif', kind: 'gif', credit: 'HighwayEnv docs', page: 'https://highway-env.farama.org/environments/highway/' },
  metadrive: { url: 'https://metadrive-simulator.readthedocs.io/en/latest/_images/0da6f6858bdf4edfd8ad98b87ac498968ab847462b827230590f97af320d40ca.gif', kind: 'gif', credit: 'MetaDrive docs', page: 'https://metadrive-simulator.readthedocs.io/en/latest/rl_environments.html' },
  carla: { url: 'https://raw.githubusercontent.com/carla-simulator/carla/master/Docs/img/0_9_15_thumbnail.webp', kind: 'image', credit: 'CARLA GitHub', page: 'https://github.com/carla-simulator/carla' },
};

const ENVS: Record<string, Record<string, SimPreview>> = {
  gymnasium: {
    'CartPole-v1': { url: 'https://gymnasium.farama.org/_images/cart_pole.gif', kind: 'gif' },
    'Acrobot-v1': { url: 'https://gymnasium.farama.org/_images/acrobot.gif', kind: 'gif' },
    'MountainCar-v0': { url: 'https://gymnasium.farama.org/_images/mountain_car.gif', kind: 'gif' },
    'Pendulum-v1': { url: 'https://gymnasium.farama.org/_images/pendulum.gif', kind: 'gif' },
    'MountainCarContinuous-v0': { url: 'https://gymnasium.farama.org/_images/mountain_car_continuous.gif', kind: 'gif' },
  },
  box2d: {
    'LunarLander-v3': { url: 'https://gymnasium.farama.org/_images/lunar_lander.gif', kind: 'gif' },
    'BipedalWalker-v3': { url: 'https://gymnasium.farama.org/_images/bipedal_walker.gif', kind: 'gif' },
    'CarRacing-v3': { url: 'https://gymnasium.farama.org/_images/car_racing.gif', kind: 'gif' },
  },
  mujoco: {
    'HalfCheetah-v5': { url: 'https://gymnasium.farama.org/_images/half_cheetah.gif', kind: 'gif' },
    'Hopper-v5': { url: 'https://gymnasium.farama.org/_images/hopper.gif', kind: 'gif' },
    'Walker2d-v5': { url: 'https://gymnasium.farama.org/_images/walker2d.gif', kind: 'gif' },
    'Ant-v5': { url: 'https://gymnasium.farama.org/_images/ant.gif', kind: 'gif' },
    'Humanoid-v5': { url: 'https://gymnasium.farama.org/_images/humanoid.gif', kind: 'gif' },
    'InvertedPendulum-v5': { url: 'https://gymnasium.farama.org/_images/inverted_pendulum.gif', kind: 'gif' },
  },
  mujoco_playground: {
    'Go1JoystickFlatTerrain': { url: 'https://playground.mujoco.org/assets/go1_sim2sim.mp4', kind: 'video', page: 'https://playground.mujoco.org/', note: 'the simulated Go1 on rough terrain, filmed off a screen' },
    'LeapCubeReorient': { url: 'https://playground.mujoco.org/assets/inhand_sim2sim.mp4', kind: 'video', page: 'https://playground.mujoco.org/' },
    'PandaPickCube': { url: 'https://playground.mujoco.org/assets/vision_pick.mp4', kind: 'video', page: 'https://playground.mujoco.org/', note: 'the real robot doing this task, not the simulation' },
  },
  brax: {
    'ant': { url: 'https://raw.githubusercontent.com/google/brax/main/docs/img/ant_v2.gif', kind: 'gif', page: 'https://github.com/google/brax#readme' },
    'halfcheetah': { url: 'https://raw.githubusercontent.com/google/brax/main/docs/img/halfcheetah.gif', kind: 'gif', page: 'https://github.com/google/brax/tree/main/docs/img' },
    'humanoid': { url: 'https://raw.githubusercontent.com/google/brax/main/docs/img/humanoid_v2.gif', kind: 'gif', page: 'https://github.com/google/brax#readme' },
  },
  gymnasium_robotics: {
    'HandManipulateBlock-v1': { url: 'https://robotics.farama.org/_images/manipulate_block.gif', kind: 'gif', page: 'https://robotics.farama.org/envs/shadow_dexterous_hand/manipulate_block/' },
    'HandManipulateEgg-v1': { url: 'https://robotics.farama.org/_images/manipulate_egg.gif', kind: 'gif', page: 'https://robotics.farama.org/envs/shadow_dexterous_hand/manipulate_egg/' },
    'HandReach-v2': { url: 'https://robotics.farama.org/_images/reach1.gif', kind: 'gif', page: 'https://robotics.farama.org/envs/shadow_dexterous_hand/reach/' },
    'AdroitHandDoor-v1': { url: 'https://robotics.farama.org/_images/adroit_door.gif', kind: 'gif', page: 'https://robotics.farama.org/envs/adroit_hand/adroit_door/', bytes: 43362330 },
    'FetchReach-v4': { url: 'https://robotics.farama.org/_images/reach.gif', kind: 'gif', page: 'https://robotics.farama.org/envs/fetch/reach/' },
    'FetchPickAndPlace-v4': { url: 'https://robotics.farama.org/_images/pick_and_place.gif', kind: 'gif', page: 'https://robotics.farama.org/envs/fetch/pick_and_place/' },
  },
  myosuite: {
    'myoHandPoseRandom-v0': { url: 'https://myosuite.readthedocs.io/en/latest/_images/hand_joint_pose.png', kind: 'image', page: 'https://myosuite.readthedocs.io/en/latest/suite.html' },
    'myoHandReachRandom-v0': { url: 'https://myosuite.readthedocs.io/en/latest/_images/hand_tip_reach.png', kind: 'image', page: 'https://myosuite.readthedocs.io/en/latest/suite.html' },
    'myoElbowPose1D6MRandom-v0': { url: 'https://myosuite.readthedocs.io/en/latest/_images/elbow_joint_pose.png', kind: 'image', page: 'https://myosuite.readthedocs.io/en/latest/suite.html' },
  },
  metaworld: {
    'pick-place-v3': { url: 'https://metaworld.farama.org/_images/mt1.gif', kind: 'gif', page: 'https://metaworld.farama.org/benchmark/benchmark_descriptions/' },
  },
  robosuite: {
    'Lift': { url: 'https://robosuite.ai/docs/_images/env_lift.png', kind: 'image', page: 'https://robosuite.ai/docs/modules/environments.html' },
    'Stack': { url: 'https://robosuite.ai/docs/_images/env_stack.png', kind: 'image', page: 'https://robosuite.ai/docs/modules/environments.html' },
    'Door': { url: 'https://robosuite.ai/docs/_images/env_door.png', kind: 'image', page: 'https://robosuite.ai/docs/modules/environments.html' },
    'NutAssembly': { url: 'https://robosuite.ai/docs/_images/env_nut_assembly.png', kind: 'image', page: 'https://robosuite.ai/docs/modules/environments.html' },
  },
};

/** The preview for a simulator, or for one of its environments when that has its own. */
export function previewFor(simId: string, envId?: string): SimPreview | null {
  const own = envId ? ENVS[simId]?.[envId] : undefined;
  if (own) return { credit: SIMS[simId]?.credit, page: SIMS[simId]?.page, ...own, own: true };
  return SIMS[simId] ?? null;
}

const warmed = new Set<string>();
/** Start fetching a clip before it is asked for (the pointer is over its environment), so it shows at once when picked. */
export function warmPreview(preview: SimPreview | null) {
  if (!preview || preview.kind === 'video' || (preview.bytes ?? 0) >= HEAVY || warmed.has(preview.url)) return;
  warmed.add(preview.url);
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.src = preview.url;
}
