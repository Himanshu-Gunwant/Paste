import type { RequestHandler } from 'express';
import * as discoveryService from '../services/discovery.service.js';
import type { FeedQuery, SearchQuery } from '../validators/discovery.validators.js';

/** Discovery HTTP adapters (docs/ARCHITECTURE.md §4 G, §7.2). */
export const feed: RequestHandler = async (req, res) => {
  const query = req.validated.query as FeedQuery;
  const result = await discoveryService.listPublicPastes({
    sort: query.sort,
    language: query.language,
    username: query.username,
    cursor: query.cursor,
    limit: query.limit,
  });
  res.status(200).json(result);
};

export const search: RequestHandler = async (req, res) => {
  const query = req.validated.query as SearchQuery;
  const result = await discoveryService.searchPublicPastes({
    q: query.q,
    language: query.language,
    username: query.username,
    cursor: query.cursor,
    limit: query.limit,
  });
  res.status(200).json(result);
};

export const languages: RequestHandler = async (_req, res) => {
  const facets = await discoveryService.getLanguageFacets();
  res.status(200).json({ data: facets });
};
