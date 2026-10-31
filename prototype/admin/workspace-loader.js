export const viewIsAllowed = (view, can) => ({
  home: true,
  surface: can('studio:read'),
  content: can('media:read') || can('messages:read'),
  brand: can('instance:write'),
  fleet: can('fleet:read'),
  releases: can('releases:read'),
  security: true,
}[view] ?? false);

// Delegated release/security roles cannot read the Studio document. Load only
// their authorized endpoints rather than treating a normal 403 as an outage.
export const loadWorkspacePayload = async (api, can, sceneId = null) => {
  if (can('studio:read')) {
    return api.get(sceneId ? `studio?sceneId=${encodeURIComponent(sceneId)}` : 'studio');
  }
  const [instance, fleet, groups, releases] = await Promise.all([
    api.get('instance'),
    can('fleet:read') ? api.get('tvs') : {},
    can('fleet:read') ? api.get('groups') : {},
    can('releases:read') ? api.get('releases') : {},
  ]);
  return {
    instance,
    scene: null,
    tvs: fleet.tvs ?? [],
    groups: groups.groups ?? [],
    applicationStatuses: fleet.applicationStatuses ?? [],
    measuredMetrics: fleet.measuredMetrics ?? null,
    releases: releases.releases ?? [],
    deployments: releases.deployments ?? [],
    serverUpdateRequests: releases.serverUpdateRequests ?? [],
    releaseSource: releases.source ?? null,
    serverUpdatePolicy: releases.policy ?? null,
  };
};
