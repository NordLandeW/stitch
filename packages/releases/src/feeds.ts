import { Pathy } from '@bscotch/pathy';
import { z } from 'zod';
import { defaultNotesCachePath } from './constants.js';
import { downloadRssFeed, findPairedRuntime } from './feeds.lib.js';
import {
  ArtifactType,
  Channel,
  GameMakerArtifact,
  GameMakerRelease,
  GameMakerReleaseWithNotes,
  RssFeedEntry,
  channels,
  gameMakerArtifactSchema,
  gameMakerReleaseSchema,
  gameMakerReleaseWithNotesSchema,
} from './feeds.types.js';
import { listReleaseNotes } from './notes.js';
import { ideFeedUrls, runtimeFeedUrls } from './urls.js';

export type RssFeedDownloader = (url: string) => Promise<RssFeedEntry[]>;

const liveFeedCache = new Map<
  string,
  { expiresAt: number; promise: Promise<RssFeedEntry[]> }
>();
const liveFeedCacheDurationMs = 60_000;

/**
 * Find an IDE release and its paired Runtime directly from the RSS feeds.
 *
 * IDE feeds are checked in channel order. Once the IDE version is found,
 * only the matching channel's Runtime feed is downloaded.
 */
export async function findReleaseFromFeeds(
  ideVersion: string,
  downloadFeed: RssFeedDownloader = downloadLiveRssFeed,
): Promise<GameMakerRelease | undefined> {
  const ideUrls = ideFeedUrls();
  const runtimeUrls = runtimeFeedUrls();
  const feedErrors: unknown[] = [];

  for (const channel of channels) {
    let ideEntries: RssFeedEntry[];
    try {
      ideEntries = await downloadFeed(ideUrls[channel]);
    } catch (error) {
      feedErrors.push(error);
      continue;
    }

    const ideEntry = ideEntries.find(
      (entry) => entry.title === `Version ${ideVersion}`,
    );
    if (!ideEntry) {
      continue;
    }

    const ide = artifactFromFeedEntry(
      'ide',
      channel,
      ideUrls[channel],
      ideEntry,
    );
    const runtimeEntries = await downloadFeed(runtimeUrls[channel]);
    const runtimes = runtimeEntries.map((entry) =>
      artifactFromFeedEntry('runtime', channel, runtimeUrls[channel], entry),
    );
    const runtime = findPairedRuntime(runtimes, ide);
    if (!runtime) {
      return undefined;
    }

    return gameMakerReleaseSchema.parse({
      channel,
      summary: ide.summary,
      publishedAt: ide.publishedAt,
      ide,
      runtime,
    });
  }

  if (feedErrors.length) {
    throw new AggregateError(
      feedErrors,
      `Could not search all IDE feeds for version ${ideVersion}`,
    );
  }
  return undefined;
}

async function downloadLiveRssFeed(url: string): Promise<RssFeedEntry[]> {
  const cached = liveFeedCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = downloadRssFeed(url);
  liveFeedCache.set(url, {
    expiresAt: Date.now() + liveFeedCacheDurationMs,
    promise,
  });
  try {
    return await promise;
  } catch (error) {
    if (liveFeedCache.get(url)?.promise === promise) {
      liveFeedCache.delete(url);
    }
    throw error;
  }
}

export async function computeReleasesSummaryWithNotes(
  releases?: GameMakerRelease[],
  cache: Pathy | string = defaultNotesCachePath,
): Promise<GameMakerReleaseWithNotes[]> {
  releases ||= await computeReleasesSummary();
  const notes = await listReleaseNotes(releases, cache);
  const withNotes: GameMakerReleaseWithNotes[] = [];
  const emptyChanges = {
    changes: {
      since: null,
      groups: [],
    },
  };
  for (const release of releases) {
    const ideNotes = notes[release.ide.notesUrl] || emptyChanges;
    const runtimeNotes = notes[release.runtime.notesUrl] || emptyChanges;
    const ide = { ...release.ide, notes: ideNotes.changes };
    const runtime = { ...release.runtime, notes: runtimeNotes.changes };
    withNotes.push({
      channel: release.channel,
      summary: release.summary,
      publishedAt: release.publishedAt,
      ide,
      runtime,
    });
  }
  withNotes.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );
  return z.array(gameMakerReleaseWithNotesSchema).parse(withNotes);
}

export async function computeReleasesSummary(): Promise<GameMakerRelease[]> {
  const ideArtifacts = await listArtifacts('ide');
  const runtimeArtifacts = await listArtifacts('runtime');
  const releases: GameMakerRelease[] = [];
  for (let i = 0; i < ideArtifacts.length; i++) {
    const ide = ideArtifacts[i];
    if (!ide.publishedAt) {
      continue;
    }
    const runtime = findPairedRuntime(runtimeArtifacts, ide);
    if (!runtime) {
      continue;
    }
    releases.push({
      channel: ide.channel,
      summary: ide.summary!,
      publishedAt: ide.publishedAt,
      ide,
      runtime,
    });
  }
  releases.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );
  return z.array(gameMakerReleaseSchema).parse(releases);
}

async function listArtifacts(type: ArtifactType): Promise<GameMakerArtifact[]> {
  const entries: GameMakerArtifact[] = [];
  const urls = type === 'ide' ? ideFeedUrls() : runtimeFeedUrls();
  const feeds = await Promise.all(
    channels.map((channel) => downloadRssFeed(urls[channel])),
  );
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    const feed = feeds[i];
    for (const entry of feed) {
      entries.push(artifactFromFeedEntry(type, channel, urls[channel], entry));
    }
  }
  entries.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );
  return entries;
}

function artifactFromFeedEntry(
  type: ArtifactType,
  channel: Channel,
  feedUrl: string,
  entry: RssFeedEntry,
): GameMakerArtifact {
  return gameMakerArtifactSchema.parse({
    type,
    channel,
    publishedAt: entry.pubDate,
    version: entry.title.match(/^Version (.*)/)![1],
    link: entry.link,
    feedUrl,
    summary: entry.description,
    notesUrl: entry.comments,
  });
}
