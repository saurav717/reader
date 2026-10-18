import { useState, type CSSProperties, type ReactNode } from 'react';
import { basePath } from '../lib/route';

/**
 * The night: the scenes the site opens on. One is chosen for each visit, the
 * next in turn, and the loading screen and the opening screen share it, so
 * the picture under "Reading your library" is the one the sign-in then sits
 * on. The images are public/loading/scene-NN.jpg; the words are set here, by
 * the app, so they stay text.
 */
export type Scene = {
  file: string;
  /** Two lines, set one above the other. */
  headline: [string, string];
  intro: string;
  /** Where the picture's subject is, for object-position when the window crops it. */
  focus: string;
};

const INTRO = {
  axis: 'Koios was the Titan who held the northern pillar of the sky, the axis the stars revolve around. The Greeks heard in his name the question itself.',
  mind: 'Koios, the Titan of the inquiring mind. The quiet one among the Titans, who held still while the sky moved, and taught the stars to be read.',
  pole: 'Koios held the pole the heavens turn on. Of the twelve Titans he is the one named for perceiving: to see clearly, and to ask.',
  way: 'Koios, Titan of the axis. Where the sky turns the stars keep their places, and the one who reads them finds the way.',
  north: 'Koios, the Titan of the inquiring mind, held the north while the heavens wheeled. One fixed point is enough to steer by.',
  still: 'The Titan Koios held the axis of the sky. Named for the question, he is the still point from which the stars are read.',
};

export const SCENES: Scene[] = [
  { file: 'scene-01.jpg', headline: ['The heavens turn.', 'The still point holds.'], intro: INTRO.axis, focus: '78% 50%' },
  { file: 'scene-02.jpg', headline: ['Ask well. Read slowly.', 'Keep what matters.'], intro: INTRO.mind, focus: '82% 50%' },
  { file: 'scene-03.jpg', headline: ['Every paper is a star.', 'Take your bearing.'], intro: INTRO.pole, focus: '80% 50%' },
  { file: 'scene-04.jpg', headline: ['What is worth knowing', 'is worth finding.'], intro: INTRO.way, focus: '78% 50%' },
  { file: 'scene-05.jpg', headline: ['Attend to the paper', 'in front of you.'], intro: INTRO.north, focus: '80% 50%' },
  { file: 'scene-06.jpg', headline: ['Stand still.', 'Let the literature turn around you.'], intro: INTRO.still, focus: '85% 50%' },
  { file: 'scene-07.jpg', headline: ['One fixed point', 'is enough to steer by.'], intro: INTRO.axis, focus: '72% 50%' },
  { file: 'scene-08.jpg', headline: ['Begin with the question.', 'The rest follows.'], intro: INTRO.mind, focus: '76% 50%' },
  { file: 'scene-09.jpg', headline: ['Read one thing well.', 'Then the next.'], intro: INTRO.north, focus: '74% 50%' },
  { file: 'scene-10.jpg', headline: ['Every paper is a star.', 'Take your bearing.'], intro: INTRO.pole, focus: '74% 50%' },
  { file: 'scene-11.jpg', headline: ['Reach for what', 'is worth knowing.'], intro: INTRO.way, focus: '72% 50%' },
];

const TURN_KEY = 'koios:scene';
let chosen: Scene | null = null;

/** This visit's scene: the one after last visit's, so they come round in turn. */
export function pickScene(): Scene {
  if (chosen) return chosen;
  let at = Math.floor(Math.random() * SCENES.length);
  try {
    const last = Number(localStorage.getItem(TURN_KEY));
    if (Number.isFinite(last) && last >= 0) at = (last + 1) % SCENES.length;
    localStorage.setItem(TURN_KEY, String(at));
  } catch {
    // Storage closed to us: a random scene is still a scene.
  }
  chosen = SCENES[at];
  return chosen;
}

export function sceneUrl(scene: Scene): string {
  return `${basePath()}loading/${scene.file}`;
}

/** The Koios mark — a bookmark with a star cut out of it; public/icons/koios.svg is the same path. */
export function KoiosMark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M17 5 H47 V59 L32 46 L17 59 Z M32 12 L34.6 20.4 L43 23 L34.6 25.6 L32 34 L29.4 25.6 L21 23 L29.4 20.4 Z"
      />
    </svg>
  );
}

function Star({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className={className}>
      <path fill="currentColor" d="M12 1 L13.9 9.5 L23 12 L13.9 14.5 L12 23 L10.1 14.5 L1 12 L10.1 9.5 Z" />
    </svg>
  );
}

/** The picture and the veil over it. The words come first in the DOM; the picture fades in when it has arrived. */
export function SceneBackdrop({ scene }: { scene: Scene }) {
  const [arrived, setArrived] = useState(false);
  return (
    <>
      <img
        className={`night-img${arrived ? ' is-in' : ''}`}
        src={sceneUrl(scene)}
        alt=""
        decoding="async"
        onLoad={() => setArrived(true)}
        style={{ objectPosition: scene.focus }}
      />
      <div className="night-veil" aria-hidden="true" />
    </>
  );
}

/** A scene with the words on it: the loading screen is this with a rule at the foot; the opening screen puts its sign-in under the words. */
export function NightScene({ scene, className, children, foot }: { scene: Scene; className?: string; children?: ReactNode; foot?: ReactNode }) {
  return (
    <div className={`night night-scene${className ? ` ${className}` : ''}`} style={{ '--focus': scene.focus } as CSSProperties}>
      <SceneBackdrop scene={scene} />
      <div className="night-mark">
        <KoiosMark />
        <span>koios</span>
      </div>
      <div className="night-copy">
        <h1>
          {scene.headline[0]}
          <br />
          {scene.headline[1]}
        </h1>
        <p className="night-intro">{scene.intro}</p>
        {children}
      </div>
      {foot}
    </div>
  );
}

/**
 * The loading screen: nothing of the library shows until it is read, and this
 * is what shows instead. The rule at the foot has no end to reach, since the
 * read's length is not known, so its star goes back and forth.
 */
export function LoadingScreen({ label }: { label: string }) {
  const scene = pickScene();
  return (
    <NightScene
      scene={scene}
      className="is-loading"
      foot={
        <div className="night-foot" role="status" aria-live="polite">
          <span>{label}</span>
          <div className="night-rule is-busy" aria-hidden="true">
            <div className="night-rule-fill" />
            <Star className="night-rule-star" />
          </div>
        </div>
      }
    />
  );
}
