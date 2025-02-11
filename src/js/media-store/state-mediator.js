import { document, globalThis } from '../utils/server-safe-globals.js';
import {
  AvailabilityStates,
  StreamTypes,
  TextTrackKinds,
  WebkitPresentationModes,
} from '../constants.js';
import { containsComposedNode } from '../utils/element-utils.js';
import { fullscreenApi } from '../utils/fullscreen-api.js';
import {
  airplaySupported,
  castSupported,
  fullscreenSupported,
  hasFullscreenSupport,
  hasPipSupport,
  hasVolumeSupportAsync,
  pipSupported,
} from '../utils/platform-tests.js';
import {
  getShowingSubtitleTracks,
  getSubtitleTracks,
  toggleSubtitleTracks,
} from './util.js';
import { getTextTracksList } from '../utils/captions.js';

/**
 * @typedef {'on-demand'|'live'|'unknown'} StreamTypeValue
 */

/**
 * @typedef {'unavailable'|'unsupported'} AvailabilityTypeValue
 */

/**
 *
 * MediaStateOwner is in a sense both a subset and a superset of `HTMLVideoElement` and is used as the primary
 * "source of truth" for media state, as well as the primary target for state change requests.
 *
 * It is a subset insofar as only the `play()` method, the `paused` property, and the `addEventListener()`/`removeEventListener()` methods
 * are *required* and required to conform to their definition of `HTMLMediaElement` on the entity used. All other interfaces
 * (properties, methods, events, etc.) are optional, but, when present, *must* conform to `HTMLMediaElement`/`HTMLVideoElement`
 * to avoid unexpected state behavior. This includes, for example, ensuring state updates occur *before* related events are fired
 * that are used to monitor for potential state changes.
 *
 * It is a superset insofar as it supports an extended interface for media state that may be browser-specific (e.g. `webkit`-prefixed
 * properties/methods) or are not immediately derivable from primary media state or other state owners. These include things like
 * `videoRenditions` for e.g. HTTP Adaptive Streaming media (such as HLS or MPEG-DASH), `audioTracks`, or `streamType`, which identifies
 * whether the media ("stream") is "live" or "on demand". Several of these are specified and formalized on https://github.com/video-dev/media-ui-extensions.
 *
 * @typedef {Partial<HTMLVideoElement> & Pick<HTMLMediaElement, 'play' | 'paused' | 'addEventListener' | 'removeEventListener'> & {
 *  streamType?: StreamTypeValue;
 *  targetLiveWindow?: number;
 *  liveEdgeStart?: number;
 *  videoRenditions?: { id?: any; }[] & EventTarget & { selectedIndex?: number };
 *  audioTracks?: { id?: any; enabled?: boolean; }[] & EventTarget;
 *  requestCast?: () => any;
 *  webkitDisplayingFullscreen?: boolean;
 *  webkitPresentationMode?: 'fullscreen'|'picture-in-picture';
 *  webkitEnterFullscreen?: () => any;
 *  webkitCurrentPlaybackTargetIsWireless?: boolean;
 *  webkitShowPlaybackTargetPicker?: () => any;
 * }} MediaStateOwner
 */

/**
 * @typedef {Partial<Document|ShadowRoot>} RootNodeStateOwner
 */

/**
 * @typedef {Partial<HTMLElement> & EventTarget} FullScreenElementStateOwner
 */

/**
 * @typedef {object} StateOption
 * @property {boolean} [defaultSubtitles]
 * @property {StreamTypeValue} [defaultStreamType]
 * @property {number} [defaultDuration]
 * @property {number} [liveEdgeOffset]
 * @property {boolean} [noVolumePref]
 * @property {boolean} [noSubtitlesLangPref]
 */

/**
 *
 * StateOwners are anything considered a source of truth or a target for updates for state. The media element (or "element") is a source of truth for the state of media playback,
 * but other things could also be a source of truth for information about the media. These include:
 *
 * - media - the media element
 * - fullscreenElement - the element that will be used when in full screen (e.g. for Media Chrome, this will typically be the MediaController)
 * - documentElement - top level node for DOM context (usually document and defaults to `document` in `createMediaStore()`)
 * - options - state behavior/user preferences (e.g. defaultSubtitles to enable subtitles by default as the relevant state or state owners change)
 *
 * @typedef {object} StateOwners
 * @property {MediaStateOwner} [media]
 * @property {RootNodeStateOwner} [documentElement]
 * @property {FullScreenElementStateOwner} [fullscreenElement]
 * @property {StateOption} [options]
 */

/**
 * @typedef {{ type: Event['type']; detail?: D; target?: Event['target'] }} EventOrAction<D>
 * @template {any} [D=undefined]
 */

/**
 * @typedef {(stateOwners: StateOwners, event?: EventOrAction<D>) => T} FacadeGetter<T>
 * @template T
 * @template {any} [D=T]
 */

/**
 * @typedef {(value: T, stateOwners: StateOwners) => void} FacadeSetter<T>
 * @template T
 */

/**
 *
 * @typedef {(handler: (value: T) => void, stateOwners: StateOwners) => void} StateOwnerUpdateHandler<T>
 * @template T
 */

/**
 * @typedef {{
 *   get: FacadeGetter<T,D>;
 *   mediaEvents?: string[];
 *   textTracksEvents?: string[];
 *   videoRenditionsEvents?: string[];
 *   audioTracksEvents?: string[];
 *   remoteEvents?: string[];
 *   rootEvents?: string[];
 *   stateOwnersUpdateHandlers?: StateOwnerUpdateHandler<T>[];
 * }} ReadonlyFacadeProp<T>
 * @template T
 * @template {any} [D=T]
 */

/**
 * @typedef {ReadonlyFacadeProp<T,D> & { set: FacadeSetter<S> }} FacadeProp<T,S,D>
 * @template T
 * @template {any} [S=T]
 * @template {any} [D=T]
 */

/**
 *
 * StateMediator provides a stateless, well-defined API for getting and setting/updating media-relevant state on a set of (stateful) StateOwners.
 * In addition, it identifies monitoring conditions for potential state changes for any given bit of state. StateMediator is designed to be used
 * by a MediaStore, which owns all of the wiring up and persistence of e.g. StateOwners, MediaState, and the StateMediator.
 *
 * For any modeled state, the StateMediator defines a key, K, which names the state (e.g. `mediaPaused`, `mediaSubtitlesShowing`, `mediaCastUnavailable`,
 * etc.), whose value defines the aforementioned using:
 *
 * - `get(stateOwners, event)` - Retrieves the current state of K from StateOwners, potentially using the (optional) event to help identify the state.
 * - `set(value, stateOwners)` (Optional, not available for `Readonly` state) - Interact with StateOwners via their interfaces to (directly or indirectly) update the state of K, using the value to determine the intended state change side effects.
 * - `mediaEvents[]` (Optional) - An array of event types to monitor on `stateOwners.media` for potential changes in the state of K.
 * - `textTracksEvents[]` (Optional) - An array of event types to monitor on `stateOwners.media.textTracks` for potential changes in the state of K.
 * - `videoRenditionsEvents[]` (Optional) - An array of event types to monitor on `stateOwners.media.videoRenditions` for potential changes in the state of K.
 * - `audioTracksEvents[]` (Optional) - An array of event types to monitor on `stateOwners.media.audioTracks` for potential changes in the state of K.
 * - `remoteEvents[]` (Optional) - An array of event types to monitor on `stateOwners.media.remote` for potential changes in the state of K.
 * - `rootEvents[]` (Optional) - An array of event types to monitor on `stateOwners.documentElement` for potential changes in the state of K.
 * - `stateOwnersUpdateHandlers[]` (Optional) - An array of functions that define arbitrary code for monitoring or causing state changes, optionally returning a "teardown" function for cleanup.
 *
 * @typedef {{
 *   mediaPaused: FacadeProp<HTMLMediaElement['paused']>
 *   mediaHasPlayed: ReadonlyFacadeProp<boolean>;
 *   mediaEnded: ReadonlyFacadeProp<HTMLMediaElement['ended']>;
 *   mediaPlaybackRate: FacadeProp<HTMLMediaElement['playbackRate']>;
 *   mediaMuted: FacadeProp<HTMLMediaElement['muted']>;
 *   mediaVolume: FacadeProp<HTMLMediaElement['volume']>;
 *   mediaVolumeLevel: ReadonlyFacadeProp<'high'|'medium'|'low'|'off'>
 *   mediaCurrentTime: FacadeProp<HTMLMediaElement['currentTime']>;
 *   mediaDuration: ReadonlyFacadeProp<HTMLMediaElement['duration']>;
 *   mediaLoading: ReadonlyFacadeProp<boolean>;
 *   mediaSeekable: ReadonlyFacadeProp<[number, number]|undefined>;
 *   mediaBuffered: ReadonlyFacadeProp<[number, number][]>;
 *   mediaStreamType: ReadonlyFacadeProp<StreamTypeValue>;
 *   mediaTargetLiveWindow: ReadonlyFacadeProp<number>;
 *   mediaTimeIsLive: ReadonlyFacadeProp<boolean>;
 *   mediaSubtitlesList: ReadonlyFacadeProp<Pick<TextTrack,'kind'|'label'|'language'>[]>;
 *   mediaSubtitlesShowing: ReadonlyFacadeProp<Pick<TextTrack,'kind'|'label'|'language'>[]>;
 *   mediaChaptersCues: ReadonlyFacadeProp<Pick<VTTCue,'text'|'startTime'|'endTime'>[]>;
 *   mediaIsPip: FacadeProp<boolean>;
 *   mediaRenditionList: ReadonlyFacadeProp<{ id?: string }[]>;
 *   mediaRenditionSelected: FacadeProp<{ id?: string }[],string>;
 *   mediaAudioTrackList: ReadonlyFacadeProp<{ id?: string }[]>;
 *   mediaAudioTrackEnabled: FacadeProp<{ id?: string }[],string>;
 *   mediaIsFullscreen: FacadeProp<boolean>;
 *   mediaIsCasting: FacadeProp<boolean,boolean,'NO_DEVICES_AVAILABLE'|'NOT_CONNECTED'|'CONNECTING'|'CONNECTED'>;
 *   mediaIsAirplaying: FacadeProp<boolean>;
 *   mediaFullscreenUnavailable: ReadonlyFacadeProp<AvailabilityTypeValue|undefined>;
 *   mediaPipUnavailable: ReadonlyFacadeProp<AvailabilityTypeValue|undefined>;
 *   mediaVolumeUnavailable: ReadonlyFacadeProp<AvailabilityTypeValue|undefined>;
 *   mediaCastUnavailable: ReadonlyFacadeProp<AvailabilityTypeValue|undefined>;
 *   mediaAirplayUnavailable: ReadonlyFacadeProp<AvailabilityTypeValue|undefined>;
 *   mediaRenditionUnavailable: ReadonlyFacadeProp<AvailabilityTypeValue|undefined>;
 *   mediaAudioTrackUnavailable: ReadonlyFacadeProp<AvailabilityTypeValue|undefined>;
 * }} StateMediator
 *
 * @example &lt;caption>Basic Example (NOTE: This is for informative use only. StateMediator is not intended to be used directly).&lt;/caption>
 *
 * // Simple stateOwners example
 * const stateOwners = {
 *   media: myVideoElement,
 *   fullscreenElement: myMediaUIContainerElement,
 *   documentElement: document,
 * };
 *
 * // Current mediaPaused state
 * let mediaPaused = stateMediator.mediaPaused.get(stateOwners);
 *
 * // Event handler to update mediaPaused to its latest state;
 * const updateMediaPausedEventHandler = (event) => {
 *   mediaPaused = stateMediator.mediaPaused.get(stateOwners, event);
 * };
 *
 * // Monitor for potential changes to mediaPaused state.
 * stateMediator.mediaPaused.mediaEvents.forEach(eventType => {
 *   stateOwners.media.addEventListener(eventType, updateMediaPausedEventHandler);
 * });
 *
 * // Function to toggle between mediaPaused and !mediaPaused (media "unpaused", or "playing" under normal conditions)
 * const toggleMediaPaused = () => {
 *   const nextMediaPaused = !mediaPaused;
 *   stateMediator.mediaPaused.set(nextMediaPaused, stateOwners);
 * };
 *
 *
 * // ... Eventual teardown, when relevant. This is especially relevant for potential garbage collection/memory management considerations.
 * stateMediator.mediaPaused.mediaEvents.forEach(eventType => {
 *   stateOwners.media.removeEventListener(eventType, updateMediaPausedEventHandler);
 * });
 *
 */

const StreamTypeValues = /** @type {StreamTypeValue[]} */ (
  Object.values(StreamTypes)
);

let volumeSupported;
export const volumeSupportPromise = hasVolumeSupportAsync().then(
  (supported) => {
    volumeSupported = supported;
    return volumeSupported;
  }
);

export const prepareStateOwners = async (
  /** @type {(StateOwners[keyof StateOwners])[]} */ ...stateOwners
) => {
  await stateOwners
    .filter((x) => x)
    .forEach(async (stateOwner) => {
      if (
        !(
          'localName' in stateOwner &&
          stateOwner instanceof globalThis.HTMLElement
        )
      ) {
        return;
      }

      const name = stateOwner.localName;
      if (!name.includes('-')) return;

      const classDef = globalThis.customElements.get(name);
      if (classDef && stateOwner instanceof classDef) return;

      await globalThis.customElements.whenDefined(name);
      globalThis.customElements.upgrade(stateOwner);
    });
};

/** @type {StateMediator} */
export const stateMediator = {
  mediaPaused: {
    get(stateOwners) {
      const { media } = stateOwners;

      return media?.paused ?? true;
    },
    set(value, stateOwners) {
      const { media } = stateOwners;
      if (!media) return;
      if (value) {
        media.pause();
      } else {
        media.play().catch(() => {});
      }
    },
    mediaEvents: ['play', 'playing', 'pause', 'emptied'],
  },
  mediaHasPlayed: {
    // We want to let the user know that the media started playing at any point (`media-has-played`).
    // Since these propagators are all called when boostrapping state, let's verify this is
    // a real playing event by checking that 1) there's media and 2) it isn't currently paused.
    get(stateOwners, event) {
      const { media } = stateOwners;

      if (!media) return false;
      if (!event) return !media.paused;
      return event.type === 'playing';
    },
    mediaEvents: ['playing', 'emptied'],
  },
  mediaEnded: {
    get(stateOwners) {
      const { media } = stateOwners;

      return media?.ended ?? false;
    },
    mediaEvents: ['seeked', 'ended', 'emptied'],
  },
  mediaPlaybackRate: {
    get(stateOwners) {
      const { media } = stateOwners;

      return media?.playbackRate ?? 1;
    },
    set(value, stateOwners) {
      const { media } = stateOwners;
      if (!media) return;
      if (!Number.isFinite(+value)) return;
      media.playbackRate = +value;
    },
    mediaEvents: ['ratechange', 'loadstart'],
  },
  mediaMuted: {
    get(stateOwners) {
      const { media } = stateOwners;

      return media?.muted ?? false;
    },
    set(value, stateOwners) {
      const { media } = stateOwners;
      if (!media) return;
      media.muted = value;
    },
    mediaEvents: ['volumechange'],
  },
  mediaVolume: {
    get(stateOwners) {
      const { media } = stateOwners;

      return media?.volume ?? 1.0;
    },
    set(value, stateOwners) {
      const { media } = stateOwners;
      if (!media) return;
      // Store the last set volume as a local preference, if ls is supported
      /** @TODO How should we handle globalThis dependencies/"state ownership"? (CJP) */
      try {
        if (value == null) {
          globalThis.localStorage.removeItem('media-chrome-pref-volume');
        } else {
          globalThis.localStorage.setItem(
            'media-chrome-pref-volume',
            value.toString()
          );
        }
      } catch (err) {
        // ignore
      }
      if (!Number.isFinite(+value)) return;
      media.volume = +value;
    },
    mediaEvents: ['volumechange'],
    stateOwnersUpdateHandlers: [
      (handler, stateOwners) => {
        const {
          options: { noVolumePref },
        } = stateOwners;
        if (noVolumePref) return;
        /** @TODO How should we handle globalThis dependencies/"state ownership"? (CJP) */
        try {
          const volumePref = globalThis.localStorage.getItem(
            'media-chrome-pref-volume'
          );
          if (volumePref == null) return;
          stateMediator.mediaVolume.set(+volumePref, stateOwners);
          handler(volumePref);
        } catch (e) {
          console.debug('Error getting volume pref', e);
        }
      },
    ],
  },
  // NOTE: Keeping this roughly equivalent to prior impl to reduce number of changes,
  // however we may want to model "derived" state differently from "primary" state
  // (in this case, derived === mediaVolumeLevel, primary === mediaMuted, mediaVolume) (CJP)
  mediaVolumeLevel: {
    get(stateOwners) {
      const { media } = stateOwners;
      if (typeof media?.volume == 'undefined') return 'high';
      if (media.muted || media.volume === 0) return 'off';
      if (media.volume < 0.5) return 'low';
      if (media.volume < 0.75) return 'medium';
      return 'high';
    },
    mediaEvents: ['volumechange'],
  },
  mediaCurrentTime: {
    get(stateOwners) {
      const { media } = stateOwners;

      return media?.currentTime ?? 0;
    },
    set(value, stateOwners) {
      const { media } = stateOwners;
      // Can't set the time before the media is ready
      // Ignore if readyState isn't supported
      if (!media?.readyState) return;
      media.currentTime = value;
    },
    mediaEvents: ['timeupdate', 'loadedmetadata'],
  },
  mediaDuration: {
    get(stateOwners) {
      const { media, options: { defaultDuration } = {} } = stateOwners;

      // If `defaultduration` is set and we don't yet have a usable `duration`
      // available, use the default duration.
      if (
        defaultDuration &&
        (!media ||
          !media.duration ||
          Number.isNaN(media.duration) ||
          !Number.isFinite(media.duration))
      ) {
        return defaultDuration;
      }

      return Number.isFinite(media?.duration) ? media.duration : Number.NaN;
    },
    mediaEvents: ['durationchange', 'loadedmetadata', 'emptied'],
  },
  mediaLoading: {
    get(stateOwners) {
      const { media } = stateOwners;

      return media?.readyState < 3;
    },
    mediaEvents: ['waiting', 'playing', 'emptied'],
  },
  mediaSeekable: {
    get(stateOwners) {
      const { media } = stateOwners;

      if (!media?.seekable?.length) return undefined;

      const start = media.seekable.start(0);
      const end = media.seekable.end(media.seekable.length - 1);

      // Account for cases where metadata from slotted media has an "empty" seekable (CJP)
      if (!start && !end) return undefined;
      return [Number(start.toFixed(3)), Number(end.toFixed(3))];
    },
    mediaEvents: ['loadedmetadata', 'emptied', 'progress'],
  },
  mediaBuffered: {
    get(stateOwners) {
      const { media } = stateOwners;

      const timeRanges = /** @type {TimeRanges} */ (media?.buffered ?? []);
      return Array.from(
        /** @type {ArrayLike<any>} */ (/** @type unknown */ (timeRanges))
      ).map((_, i) => [
        Number(timeRanges.start(i).toFixed(3)),
        Number(timeRanges.end(i).toFixed(3)),
      ]);
    },
    mediaEvents: ['progress', 'emptied'],
  },
  mediaStreamType: {
    get(stateOwners) {
      const { media, options: { defaultStreamType } = {} } = stateOwners;

      const usedDefaultStreamType = [
        StreamTypes.LIVE,
        StreamTypes.ON_DEMAND,
      ].includes(/** @type {'live'|'on-demand'} */ (defaultStreamType))
        ? defaultStreamType
        : undefined;

      if (!media) return usedDefaultStreamType;

      const { streamType } = media;
      if (StreamTypeValues.includes(streamType)) {
        // If the slotted media supports `streamType` but
        // `streamType` is "unknown", prefer `usedDefaultStreamType`
        // if set (CJP)
        if (streamType === StreamTypes.UNKNOWN) {
          return usedDefaultStreamType;
        }
        return streamType;
      }
      const duration = media.duration;

      if (duration === Infinity) {
        return StreamTypes.LIVE;
      } else if (Number.isFinite(duration)) {
        return StreamTypes.ON_DEMAND;
      }

      return usedDefaultStreamType;
    },
    mediaEvents: [
      'emptied',
      'durationchange',
      'loadedmetadata',
      'streamtypechange',
    ],
  },
  mediaTargetLiveWindow: {
    get(stateOwners) {
      const { media } = stateOwners;

      if (!media) return Number.NaN;
      const { targetLiveWindow } = media;
      const streamType = stateMediator.mediaStreamType.get(stateOwners);

      // Since `NaN` represents either "unknown" or "inapplicable", need to check if `streamType`
      // is `"live"`. If so, assume it's "standard live" (aka `targetLiveWindow === 0`) (CJP)
      if (
        (targetLiveWindow == null || Number.isNaN(targetLiveWindow)) &&
        streamType === StreamTypes.LIVE
      ) {
        return 0;
      }
      return targetLiveWindow;
    },
    mediaEvents: [
      'emptied',
      'durationchange',
      'loadedmetadata',
      'streamtypechange',
      'targetlivewindowchange',
    ],
  },
  mediaTimeIsLive: {
    get(stateOwners) {
      const {
        media,
        // Default to 10 seconds
        options: { liveEdgeOffset = 10 } = {},
      } = stateOwners;

      if (!media) return false;

      if (typeof media.liveEdgeStart === 'number') {
        if (Number.isNaN(media.liveEdgeStart)) return false;
        return media.currentTime >= media.liveEdgeStart;
      }

      const live =
        stateMediator.mediaStreamType.get(stateOwners) === StreamTypes.LIVE;
      // Can't be playing live if it's not a live stream
      if (!live) return false;

      // Should this use `stateMediator.mediaSeekable.get(stateOwners)?.[1]` for separation
      // of concerns/assumptions? (CJP)
      const seekable = media.seekable;
      // If the slotted media element is live but does not expose a 'seekable' `TimeRanges` object,
      // always assume playing live
      if (!seekable) return true;
      // If there is an empty `seekable`, assume we are not playing live
      if (!seekable.length) return false;
      const liveEdgeStart = seekable.end(seekable.length - 1) - liveEdgeOffset;
      return media.currentTime >= liveEdgeStart;
    },
    mediaEvents: ['playing', 'timeupdate', 'progress', 'waiting', 'emptied'],
  },
  // Text Tracks modeling
  mediaSubtitlesList: {
    get(stateOwners) {
      return getSubtitleTracks(stateOwners).map(
        ({ kind, label, language }) => ({ kind, label, language })
      );
    },
    mediaEvents: ['loadstart'],
    textTracksEvents: ['addtrack', 'removetrack'],
  },
  mediaSubtitlesShowing: {
    get(stateOwners) {
      return getShowingSubtitleTracks(stateOwners).map(
        ({ kind, label, language }) => ({ kind, label, language })
      );
    },
    mediaEvents: ['loadstart'],
    textTracksEvents: ['addtrack', 'removetrack', 'change'],
    stateOwnersUpdateHandlers: [
      (_handler, stateOwners) => {
        const { media, options } = stateOwners;
        if (!media) return;

        const updateDefaultSubtitlesCallback = (event) => {
          if (!options.defaultSubtitles) return;

          const nonSubsEvent =
            event &&
            ![TextTrackKinds.CAPTIONS, TextTrackKinds.SUBTITLES].includes(
              // @ts-ignore
              event?.track?.kind
            );

          if (nonSubsEvent) return;

          // NOTE: In this use case, since we're causing a side effect, no need to invoke `handler()`. (CJP)
          toggleSubtitleTracks(stateOwners, true);
        };

        media.textTracks?.addEventListener(
          'addtrack',
          updateDefaultSubtitlesCallback
        );
        media.textTracks?.addEventListener(
          'removetrack',
          updateDefaultSubtitlesCallback
        );

        // Invoke immediately as well, in case subs/cc tracks are already added
        updateDefaultSubtitlesCallback();

        return () => {
          media.textTracks?.removeEventListener(
            'addtrack',
            updateDefaultSubtitlesCallback
          );
          media.textTracks?.removeEventListener(
            'removetrack',
            updateDefaultSubtitlesCallback
          );
        };
      },
    ],
  },
  mediaChaptersCues: {
    get(stateOwners) {
      const { media } = stateOwners;
      if (!media) return [];

      const [chaptersTrack] = getTextTracksList(media, {
        kind: TextTrackKinds.CHAPTERS,
      });

      return Array.from(chaptersTrack?.cues ?? []).map(
        (/** @type VTTCue */ { text, startTime, endTime }) => ({
          text,
          startTime,
          endTime,
        })
      );
    },
    mediaEvents: ['loadstart', 'loadedmetadata'],
    textTracksEvents: ['addtrack', 'removetrack', 'change'],
    stateOwnersUpdateHandlers: [
      (handler, stateOwners) => {
        const { media } = stateOwners;
        if (!media) return;

        /** @TODO account for adds/removes/replacements of <track> (CJP) */
        const chaptersTrack = media.querySelector(
          'track[kind="chapters"][default][src]'
        );

        /** @ts-ignore */
        chaptersTrack?.addEventListener('load', handler);

        return () => {
          /** @ts-ignore */
          chaptersTrack?.removeEventListener('load', handler);
        };
      },
    ],
  },
  // Modeling state tied to root node
  mediaIsPip: {
    get(stateOwners) {
      const { media, documentElement } = stateOwners;

      // Need a documentElement and a media StateOwner to be in PiP, so we're not PiP
      if (!media || !documentElement) return false;

      // Need a documentElement.pictureInPictureElement to be in PiP, so we're not PiP
      if (!documentElement.pictureInPictureElement) return false;

      // If documentElement.pictureInPictureElement is the media StateOwner, we're definitely in PiP
      if (documentElement.pictureInPictureElement === media) return true;

      // In this case (e.g. Safari), the pictureInPictureElement may be
      // the underlying <video> or <audio> element of a media StateOwner
      // that is a web component, even if it's not "visible" from the
      // documentElement, so check for that.
      if (documentElement.pictureInPictureElement instanceof HTMLMediaElement) {
        if (!media.localName?.includes('-')) return false;
        return containsComposedNode(media, documentElement.pictureInPictureElement);
      }

      // In this case (e.g. Chrome), the pictureInPictureElement may be
      // a web component that is "visible" from the documentElement, but should
      // have its own pictureInPictureElement on its shadowRoot for whatever
      // is "visible" at that level. Since the media StateOwner may be nested
      // inside an indeterminite number of web components, traverse each layer
      // until we either find the media StateOwner or complete the recursive check.
      if (documentElement.pictureInPictureElement.localName.includes('-')) {
        let currentRoot = documentElement.pictureInPictureElement.shadowRoot;
        while (currentRoot?.pictureInPictureElement) {
          if (currentRoot.pictureInPictureElement === media) return true;
          currentRoot = currentRoot.pictureInPictureElement?.shadowRoot;
        }
      }

      return false;
    },
    set(value, stateOwners) {
      const { media } = stateOwners;
      if (!media) return;
      if (value) {
        if (!document.pictureInPictureEnabled) {
          console.warn('MediaChrome: Picture-in-picture is not enabled');
          // Placeholder for emitting a user-facing warning
          return;
        }

        if (!media.requestPictureInPicture) {
          console.warn(
            'MediaChrome: The current media does not support picture-in-picture'
          );
          // Placeholder for emitting a user-facing warning
          return;
        }
        const warnNotReady = () => {
          console.warn(
            'MediaChrome: The media is not ready for picture-in-picture. It must have a readyState > 0.'
          );
        };

        // Should be async
        media.requestPictureInPicture().catch((err) => {
          // InvalidStateError, readyState == 0 (Not ready)
          if (err.code === 11) {
            if (!media.src) {
              console.warn(
                'MediaChrome: The media is not ready for picture-in-picture. It must have a src set.'
              );
              return;
            }
            // We can assume the viewer wants the video to load, so attempt to
            // if we can rely on readyState and preload
            // Only works in Chrome currently. Safari doesn't allow triggering
            // in an event listener. Also requires readyState == 4.
            // Firefox doesn't have the PiP API yet.
            if (media.readyState === 0 && media.preload === 'none') {
              const cleanup = () => {
                media.removeEventListener('loadedmetadata', tryPip);
                media.preload = 'none';
              };

              const tryPip = () => {
                media.requestPictureInPicture().catch(warnNotReady);
                cleanup();
              };

              media.addEventListener('loadedmetadata', tryPip);
              media.preload = 'metadata';

              // No easy way to know if this failed and we should clean up
              // quickly if it doesn't to prevent an awkward delay for the user
              setTimeout(() => {
                if (media.readyState === 0) warnNotReady();
                cleanup();
              }, 1000);
            } else {
              /** @TODO Should we actually rethrow? Feels like something we could log instead for improved devex (CJP) */
              // Rethrow if unknown context
              throw err;
            }
          } else {
            /** @TODO Should we actually rethrow? Feels like something we could log instead for improved devex (CJP) */
            // Rethrow if unknown context
            throw err;
          }
        });
      } else if (document.pictureInPictureElement) {
        document.exitPictureInPicture();
      }
    },
    mediaEvents: ['enterpictureinpicture', 'leavepictureinpicture'],
  },
  mediaRenditionList: {
    get(stateOwners) {
      const { media } = stateOwners;
      // NOTE: Copying for reference considerations (should be an array of POJOs from a state perspective) (CJP)
      return [...(media?.videoRenditions ?? [])].map((videoRendition) => ({
        ...videoRendition,
      }));
    },
    mediaEvents: ['emptied', 'loadstart'],
    videoRenditionsEvents: ['addrendition', 'removerendition'],
  },
  /** @TODO Model this as a derived value? (CJP) */
  mediaRenditionSelected: {
    get(stateOwners) {
      const { media } = stateOwners;
      return media?.videoRenditions?.[media.videoRenditions?.selectedIndex]?.id;
    },
    set(value, stateOwners) {
      const { media } = stateOwners;
      if (!media?.videoRenditions) {
        console.warn(
          'MediaController: Rendition selection not supported by this media.'
        );
        return;
      }

      const renditionId = value;
      // NOTE: videoRenditions is an array-like, not an array (CJP)
      const index = Array.prototype.findIndex.call(
        media.videoRenditions,
        (r) => r.id == renditionId
      );

      if (media.videoRenditions.selectedIndex != index) {
        media.videoRenditions.selectedIndex = index;
      }
    },
    mediaEvents: ['emptied'],
    videoRenditionsEvents: ['addrendition', 'removerendition', 'change'],
  },
  mediaAudioTrackList: {
    get(stateOwners) {
      const { media } = stateOwners;
      return [...(media?.audioTracks ?? [])];
    },
    mediaEvents: ['emptied', 'loadstart'],
    audioTracksEvents: ['addtrack', 'removetrack'],
  },
  mediaAudioTrackEnabled: {
    get(stateOwners) {
      const { media } = stateOwners;
      return [...(media?.audioTracks ?? [])].find(
        (audioTrack) => audioTrack.enabled
      )?.id;
    },
    set(value, stateOwners) {
      const { media } = stateOwners;
      if (!media?.audioTracks) {
        console.warn(
          'MediaChrome: Audio track selection not supported by this media.'
        );
        return;
      }

      const audioTrackId = value;

      for (let track of media.audioTracks) {
        track.enabled = audioTrackId == track.id;
      }
    },
    mediaEvents: ['emptied'],
    audioTracksEvents: ['addtrack', 'removetrack', 'change'],
  },
  mediaIsFullscreen: {
    get(stateOwners) {
      const {
        media,
        documentElement,
        fullscreenElement = media,
      } = stateOwners;

      // Need a documentElement and a media StateOwner to be in fullscreen, so we're not fullscreen
      if (!media || !documentElement) return false;

      // Need a documentElement.fullscreenElement to be in fullscreen, so we're not fullscreen
      if (!documentElement[fullscreenApi.element]) {
        // Except for iOS, which doesn't conform to the standard API
        // See: https://developer.apple.com/documentation/webkitjs/htmlvideoelement/1630493-webkitdisplayingfullscreen
        if (
          'webkitDisplayingFullscreen' in media &&
          'webkitPresentationMode' in media
        ) {
          // Unfortunately, webkitDisplayingFullscreen is also true when in PiP, so we also check if webkitPresentationMode is 'fullscreen'.
          return (
            media.webkitDisplayingFullscreen &&
            media.webkitPresentationMode === WebkitPresentationModes.FULLSCREEN
          );
        }
        return false;
      }

      // If documentElement.fullscreenElement is the media StateOwner, we're definitely in fullscreen
      if (documentElement[fullscreenApi.element] === fullscreenElement) return true;

      // In this case (most modern browsers, sans e.g. iOS), the fullscreenElement may be
      // a web component that is "visible" from the documentElement, but should
      // have its own fullscreenElement on its shadowRoot for whatever
      // is "visible" at that level. Since the (also named) fullscreenElement StateOwner
      // may be nested inside an indeterminite number of web components, traverse each layer
      // until we either find the fullscreen StateOwner or complete the recursive check.
      if (documentElement[fullscreenApi.element].localName.includes('-')) {
        let currentRoot = documentElement[fullscreenApi.element].shadowRoot;

        // NOTE: This is for (non-iOS) Safari < 16.4, which did not support ShadowRoot::fullscreenElement.
        // We can remove this if/when we decide those versions are old enough/not used enough to handle
        // (e.g. at the time of writing, < 16.4 ~= 1% of global market, per caniuse https://caniuse.com/mdn-api_shadowroot_fullscreenelement) (CJP)

        // We can simply check if the fullscreenElement key (typically 'fullscreenElement') is defined on the shadowRoot to determine whether or not
        // it is supported.
        if (!(fullscreenApi.element in currentRoot)) {
          // For these cases, if documentElement.fullscreenElement (aka document.fullscreenElement) contains our fullscreenElement StateOwner,
          // we'll assume that means we're in fullscreen. That should be valid for all current actual and planned supported
          // web component use cases.
          return containsComposedNode(
            documentElement[fullscreenApi.element],
            /** @TODO clean up type assumptions (e.g. Node) (CJP) */
            // @ts-ignore
            fullscreenElement
          );
        }

        while (currentRoot?.[fullscreenApi.element]) {
          if (currentRoot[fullscreenApi.element] === fullscreenElement)
            return true;
          currentRoot = currentRoot[fullscreenApi.element]?.shadowRoot;
        }
      }

      return false;
    },
    set(value, stateOwners) {
      const { media, fullscreenElement, documentElement } = stateOwners;

      // Exiting fullscreen case (generic)
      if (!value && documentElement?.[fullscreenApi.exit]) {
        const maybePromise = documentElement?.[fullscreenApi.exit]?.();
        // NOTE: Since the "official" exit fullscreen method yields a Promise that rejects
        // if not in fullscreen, this accounts for those cases.
        if (maybePromise instanceof Promise) {
          maybePromise.catch(() => {});
        }
        return;
      }

      // Entering fullscreen cases (browser-specific)
      if (fullscreenElement?.[fullscreenApi.enter]) {
        // NOTE: Since the "official" enter fullscreen method yields a Promise that rejects
        // if already in fullscreen, this accounts for those cases.
        const maybePromise = fullscreenElement[fullscreenApi.enter]?.();
        if (maybePromise instanceof Promise) {
          maybePromise.catch(() => {});
        }
      } else if (media?.webkitEnterFullscreen) {
        // Media element fullscreen using iOS API
        media.webkitEnterFullscreen();
      } else if (media?.requestFullscreen) {
        // So media els don't have to implement multiple APIs.
        media.requestFullscreen();
      }
    },
    rootEvents: fullscreenApi.rootEvents,
    // iOS requires `webkitbeginfullscreen` and `webkitendfullscreen` events on the video.
    mediaEvents: fullscreenApi.mediaEvents,
  },
  mediaIsCasting: {
    // Note this relies on a customized castable-video element.
    get(stateOwners) {
      const { media } = stateOwners;

      if (!media?.remote || media.remote?.state === 'disconnected')
        return false;

      return !!media.remote.state;
    },
    set(value, stateOwners) {
      const { media } = stateOwners;
      if (!media) return;
      if (value && media.remote?.state !== 'disconnected') return;
      if (!value && media.remote?.state !== 'connected') return;

      if (typeof media.remote.prompt !== 'function') {
        console.warn(
          'MediaChrome: Casting is not supported in this environment'
        );
        return;
      }

      // Open the browser cast menu.
      // Note this relies on a customized castable-video element.
      media.remote
        .prompt()
        // Don't warn here because catch is run when the user closes the cast menu.
        .catch(() => {});
    },
    remoteEvents: ['connect', 'connecting', 'disconnect'],
  },
  // NOTE: Newly added state for tracking airplaying
  mediaIsAirplaying: {
    // NOTE: Cannot know if airplaying since Safari doesn't fully support HTMLMediaElement::remote yet (e.g. remote::state) (CJP)
    get() {
      return false;
    },
    set(_value, stateOwners) {
      const { media } = stateOwners;
      if (!media) return;
      if (
        !(
          media.webkitShowPlaybackTargetPicker &&
          globalThis.WebKitPlaybackTargetAvailabilityEvent
        )
      ) {
        console.warn(
          'MediaChrome: received a request to select AirPlay but AirPlay is not supported in this environment'
        );
        return;
      }
      media.webkitShowPlaybackTargetPicker();
    },
    mediaEvents: ['webkitcurrentplaybacktargetiswirelesschanged'],
  },
  mediaFullscreenUnavailable: {
    get(stateOwners) {
      const { media } = stateOwners;
      if (!fullscreenSupported || !hasFullscreenSupport(media))
        return AvailabilityStates.UNSUPPORTED;
      return undefined;
    },
  },
  mediaPipUnavailable: {
    get(stateOwners) {
      const { media } = stateOwners;
      if (!pipSupported || !hasPipSupport(media))
        return AvailabilityStates.UNSUPPORTED;
    },
  },
  mediaVolumeUnavailable: {
    get(stateOwners) {
      const { media } = stateOwners;

      if (volumeSupported === false || media?.volume == undefined) {
        return AvailabilityStates.UNSUPPORTED;
      }

      return undefined;
    },
    // NOTE: Slightly different impl here. Added generic support for
    // "stateOwnersUpdateHandlers" since the original impl had to hack around
    // race conditions. (CJP)
    stateOwnersUpdateHandlers: [
      (handler) => {
        if (volumeSupported == null) {
          volumeSupportPromise.then((supported) =>
            handler(supported ? undefined : AvailabilityStates.UNSUPPORTED)
          );
        }
      },
    ],
  },
  mediaCastUnavailable: {
    // @ts-ignore
    get(stateOwners, { availability = 'not-available' } = {}) {
      const { media } = stateOwners;

      if (!castSupported || !media?.remote?.state) {
        return AvailabilityStates.UNSUPPORTED;
      }

      if (availability == null || availability === 'available')
        return undefined;

      return AvailabilityStates.UNAVAILABLE;
    },
    stateOwnersUpdateHandlers: [
      (handler, stateOwners) => {
        const { media } = stateOwners;
        if (!media) return;

        const remotePlaybackDisabled =
          media.disableRemotePlayback ||
          media.hasAttribute('disableremoteplayback');
        if (!remotePlaybackDisabled) {
          media?.remote
            ?.watchAvailability((availabilityBool) => {
              // Normalizing to `webkitplaybacktargetavailabilitychanged` for consistency.
              const availability = availabilityBool
                ? 'available'
                : 'not-available';
              // @ts-ignore
              handler({ availability });
            })
            .catch((error) => {
              if (error.name === 'NotSupportedError') {
                // Availability monitoring is not supported by the platform, so discovery of
                // remote playback devices will happen only after remote.prompt() is called.
                // @ts-ignore
                handler({ availability: null });
              } else {
                // Thrown if disableRemotePlayback is true for the media element
                // or if the source can't be played remotely.
                // Normalizing to `webkitplaybacktargetavailabilitychanged` for consistency.
                // @ts-ignore
                handler({ availability: 'not-available' });
              }
            });
        }
        return () => {
          media?.remote?.cancelWatchAvailability();
        };
      },
    ],
  },
  mediaAirplayUnavailable: {
    get(_stateOwners, event) {
      if (!airplaySupported) return AvailabilityStates.UNSUPPORTED;
      // @ts-ignore
      if (event?.availability === 'not-available') {
        return AvailabilityStates.UNAVAILABLE;
      }
      // Either available via `availability` state or not yet known
      return undefined;
    },
    // NOTE: Keeping this event, as it's still the documented way of monitoring
    // for AirPlay availability from Apple.
    // See: https://developer.apple.com/documentation/webkitjs/adding_an_airplay_button_to_your_safari_media_controls#2940021 (CJP)
    mediaEvents: ['webkitplaybacktargetavailabilitychanged'],
    stateOwnersUpdateHandlers: [
      (handler, stateOwners) => {
        const { media } = stateOwners;
        if (!media) return;

        const remotePlaybackDisabled =
          media.disableRemotePlayback ||
          media.hasAttribute('disableremoteplayback');
        if (!remotePlaybackDisabled) {
          media?.remote
            ?.watchAvailability((availabilityBool) => {
              // Normalizing to `webkitplaybacktargetavailabilitychanged` for consistency.
              const availability = availabilityBool
                ? 'available'
                : 'not-available';
              // @ts-ignore
              handler({ availability });
            })
            .catch((error) => {
              if (error.name === 'NotSupportedError') {
                // Availability monitoring is not supported by the platform, so discovery of
                // remote playback devices will happen only after remote.prompt() is called.
                // @ts-ignore
                handler({ availability: null });
              } else {
                // Thrown if disableRemotePlayback is true for the media element
                // or if the source can't be played remotely.
                // Normalizing to `webkitplaybacktargetavailabilitychanged` for consistency.
                // @ts-ignore
                handler({ availability: 'not-available' });
              }
            });
        }
        return () => {
          media?.remote?.cancelWatchAvailability();
        };
      },
    ],
  },
  mediaRenditionUnavailable: {
    get(stateOwners) {
      const { media } = stateOwners;

      if (!media?.videoRenditions) {
        return AvailabilityStates.UNSUPPORTED;
      }

      if (!media.videoRenditions?.length) {
        return AvailabilityStates.UNAVAILABLE;
      }

      return undefined;
    },
    mediaEvents: ['emptied', 'loadstart'],
    videoRenditionsEvents: ['addrendition', 'removerendition'],
  },
  mediaAudioTrackUnavailable: {
    get(stateOwners) {
      const { media } = stateOwners;

      if (!media?.audioTracks) {
        return AvailabilityStates.UNSUPPORTED;
      }

      // An audio selection is only possible if there are 2 or more audio tracks.
      if ((media.audioTracks?.length ?? 0) <= 1) {
        return AvailabilityStates.UNAVAILABLE;
      }

      return undefined;
    },
    mediaEvents: ['emptied', 'loadstart'],
    audioTracksEvents: ['addtrack', 'removetrack'],
  },
};
