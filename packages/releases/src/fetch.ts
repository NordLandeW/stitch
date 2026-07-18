import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';
import { isError } from './utils.js';

export type Validator<T> = { parse: (data: any) => T };

export async function fetchXml<T = unknown>(
  url: string,
  validator?: Validator<T>,
): Promise<T> {
  const res = await fetchUrl(url);
  try {
    const data = await res.text();
    const asJson = new XMLParser().parse(data);
    return validator ? validator.parse(asJson) : (asJson as T);
  } catch (err) {
    throw new Error(
      `Error parsing XML from ${url}: ${
        isError(err) ? err.message : 'UNKNOWN'
      }`,
    );
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  validator?: Validator<T>,
): Promise<T> {
  const res = await fetchUrl(url);
  try {
    const parsed = await res.json();
    return validator ? validator.parse(parsed) : (parsed as T);
  } catch (err) {
    throw new Error(
      `Error parsing JSON from ${url}: ${
        isError(err) ? err.message : 'UNKNOWN'
      }`,
    );
  }
}

async function fetchUrl(url: string) {
  try {
    const proxyUrl = proxyUrlFor(url);
    const res = await fetch(url, {
      agent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
    });
    if (res.status >= 300) {
      throw new Error(
        `Error fetching "${url}": ${res.status} ${res.statusText}`,
      );
    }
    return res;
  } catch (err) {
    throw new Error(
      `Error fetching "${url}": ${isError(err) ? err.message : 'UNKNOWN'}`,
    );
  }
}

function proxyUrlFor(url: string): string | undefined {
  const parsedUrl = new URL(url);
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (noProxy && shouldBypassProxy(parsedUrl, noProxy)) {
    return undefined;
  }
  if (parsedUrl.protocol === 'https:') {
    return process.env.HTTPS_PROXY || process.env.https_proxy;
  }
  return (
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy
  );
}

function shouldBypassProxy(url: URL, noProxy: string): boolean {
  const hostname = url.hostname.toLowerCase();
  return noProxy.split(',').some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (!candidate) {
      return false;
    }
    if (candidate === '*') {
      return true;
    }
    const host = candidate.replace(/^\./, '').split(':')[0];
    return hostname === host || hostname.endsWith(`.${host}`);
  });
}
