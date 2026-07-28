import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemaNames = [
  'instance.schema.json',
  'layout.schema.json',
  'content.schema.json',
  'schedule.schema.json',
  'settings.schema.json',
  'experience-bundle.schema.json',
  'update-bundle.schema.json',
  'tv-sync.schema.json',
  'tv-credential.schema.json',
];

const allowedProps = {
  text: new Set(['role', 'text', 'fontScale', 'maxLines', 'color', 'align']),
  clock: new Set(['showDate', 'showWeather', 'timezone', 'format']),
  weather: new Set(['location', 'units', 'label']),
  message: new Set(['title', 'feed', 'maximumItems']),
  image: new Set(['assetId', 'fit', 'focalX', 'focalY', 'alt']),
  video: new Set(['assetId', 'fit', 'focalX', 'focalY', 'muted', 'loop']),
  logo: new Set(['assetId', 'asset', 'fit', 'anchor', 'alt']),
  source: new Set(['source', 'label', 'physicalInput']),
  app: new Set(['applicationId', 'label', 'iconAssetId']),
  network: new Set(['label', 'value']),
};

const invalid = (code, details) => Object.assign(new Error(code), {
  statusCode: 400,
  validation: details,
});

const textValue = (value, maximum = 500) => (
  typeof value === 'string'
  && value.length <= maximum
  && !/[\u0000-\u001f\u007f]/.test(value)
);

const assetReference = (value, { allowDefault = false, nullable = true } = {}) => (
  (nullable && value === null)
  || (
    typeof value === 'string'
    && (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      || (
        allowDefault
        && /^assets\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/.test(value)
        && !value.split('/').some((part) => part === '.' || part === '..')
      )
    )
  )
);

const assertNodeProps = (node) => {
  const props = node.props;
  const reject = (property) => {
    throw invalid('invalid_node_property_value', [{ nodeId: node.id, property }]);
  };
  const optionalText = (property, maximum = 500) => {
    if (property in props && !textValue(props[property], maximum)) reject(property);
  };
  const optionalBoolean = (property) => {
    if (property in props && typeof props[property] !== 'boolean') reject(property);
  };
  const optionalNumber = (property, minimum, maximum) => {
    if (
      property in props
      && (
        typeof props[property] !== 'number'
        || !Number.isFinite(props[property])
        || props[property] < minimum
        || props[property] > maximum
      )
    ) reject(property);
  };
  const optionalInteger = (property, minimum, maximum) => {
    if (
      property in props
      && (
        !Number.isSafeInteger(props[property])
        || props[property] < minimum
        || props[property] > maximum
      )
    ) reject(property);
  };

  for (const property of [
    'text', 'title', 'label', 'value', 'alt', 'feed', 'location', 'role',
    'applicationId', 'source',
  ]) {
    optionalText(property, property === 'text' ? 500 : 200);
  }
  for (const property of ['showDate', 'showWeather', 'muted', 'loop']) optionalBoolean(property);
  for (const property of ['focalX', 'focalY']) optionalNumber(property, 0, 1);
  optionalNumber('fontScale', 0.25, 4);
  optionalInteger('maxLines', 1, 20);
  optionalInteger('maximumItems', 1, 20);

  if ('color' in props && !/^#[0-9a-f]{6}$/i.test(props.color)) reject('color');
  if ('align' in props && !['left', 'center', 'right'].includes(props.align)) reject('align');
  if ('fit' in props && !['cover', 'contain'].includes(props.fit)) reject('fit');
  if ('anchor' in props && ![
    'top-left', 'top', 'top-right', 'left', 'center', 'right',
    'bottom-left', 'bottom', 'bottom-right',
  ].includes(props.anchor)) reject('anchor');
  if ('format' in props && !['12h', '24h'].includes(props.format)) reject('format');
  if ('units' in props && !['metric', 'imperial'].includes(props.units)) reject('units');
  if (
    'timezone' in props
    && (
      !textValue(props.timezone, 100)
      || (() => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: props.timezone }).format();
          return false;
        } catch {
          return true;
        }
      })()
    )
  ) reject('timezone');
  if ('assetId' in props && !assetReference(props.assetId)) reject('assetId');
  if ('iconAssetId' in props && !assetReference(props.iconAssetId)) reject('iconAssetId');
  if ('asset' in props && !assetReference(props.asset, { allowDefault: true })) reject('asset');
  if ('physicalInput' in props && !/^(?:auto|HDMI[1-8])$/.test(props.physicalInput)) {
    reject('physicalInput');
  }
};

export const createValidators = async (contractsDir) => {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const validators = {};
  for (const name of schemaNames) {
    const schema = JSON.parse(await readFile(path.join(contractsDir, name), 'utf8'));
    validators[name] = ajv.compile(schema);
  }

  const assert = (name, value) => {
    const validate = validators[name];
    if (!validate(value)) throw invalid('contract_validation_failed', validate.errors);
    return value;
  };

  const assertLayout = (value) => {
    assert('layout.schema.json', value);
    const background = value.canvas.background;
    if (
      background.type === 'color'
      && !/^#[0-9a-f]{6}$/i.test(background.color ?? '')
    ) {
      throw invalid('invalid_canvas_background', [{ property: 'color' }]);
    }
    if (
      ['image', 'video'].includes(background.type)
      && !assetReference(background.asset, { allowDefault: true, nullable: false })
    ) {
      throw invalid('invalid_canvas_background', [{ property: 'asset' }]);
    }
    const seen = new Set();
    for (const node of value.nodes) {
      if (seen.has(node.id)) throw invalid('duplicate_node_id', [{ nodeId: node.id }]);
      seen.add(node.id);
      if (node.x + node.width > 1920 || node.y + node.height > 1080) {
        throw invalid('node_outside_canvas', [{ nodeId: node.id }]);
      }
      const permitted = allowedProps[node.kind];
      for (const key of Object.keys(node.props)) {
        if (!permitted.has(key)) throw invalid('unsupported_node_property', [{ nodeId: node.id, key }]);
      }
      for (const property of ['text', 'title', 'label', 'value', 'alt']) {
        if (property in node.props && String(node.props[property]).length > 500) {
          throw invalid('node_text_too_long', [{ nodeId: node.id, property }]);
        }
      }
      assertNodeProps(node);
      if (node.kind === 'source' && !['airplay', 'cast', 'hdmi'].includes(node.props.source)) {
        throw invalid('invalid_source_kind', [{ nodeId: node.id }]);
      }
      if (node.kind === 'app' && !/^[A-Za-z][A-Za-z0-9_.]{2,199}$/.test(node.props.applicationId ?? '')) {
        throw invalid('invalid_application_id', [{ nodeId: node.id }]);
      }
    }
    return value;
  };

  const assertSchedule = (value) => {
    assert('schedule.schema.json', value);
    try {
      new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format();
    } catch {
      throw invalid('invalid_timezone', [{ timezone: value.timezone }]);
    }
    return value;
  };

  return Object.freeze({
    assert,
    assertInstance: (value) => assert('instance.schema.json', value),
    assertLayout,
    assertContent: (value) => assert('content.schema.json', value),
    assertSchedule,
    assertSettings: (value) => assert('settings.schema.json', value),
    assertExperienceBundle: (value) => assert('experience-bundle.schema.json', value),
    assertUpdateBundle: (value) => assert('update-bundle.schema.json', value),
    assertTvSync: (value) => assert('tv-sync.schema.json', value),
    assertTvCredential: (value) => assert('tv-credential.schema.json', value),
  });
};
