import { assert } from 'chai';
import { LanguageProfile, type NativeSpecSource } from './version.js';

const bundled: NativeSpecSource = {
  path: '/spec/GmlSpec.xml',
  runtime: '2022.4.0.0',
  module: 'Base',
  bundled: true,
  sha256: 'fixture-spec-a',
};

describe('Language version inputs', function () {
  it('keeps legacy callable scripts while describing their syntax capabilities', function () {
    const profile = new LanguageProfile({ runtimeVersion: '2.2.5.481' });
    assert.equal(profile.scriptSemantics, 'legacy-callable');
    assert.isFalse(profile.supports('functions'));
    assert.isFalse(profile.supports('templateStrings'));
  });

  it('uses the requested runtime before the IDE or bundled metadata', function () {
    const profile = new LanguageProfile({
      runtimeVersion: '2.2.5.481',
      ideVersion: '2024.14.0.0',
      specSources: [bundled],
    });
    assert.equal(profile.scriptSemantics, 'legacy-callable');
    assert.equal(profile.versionSource, 'runtime');
    assert.isTrue(profile.nativeDegraded);
  });

  it('distinguishes modern scripts and later template-string syntax', function () {
    const modern = new LanguageProfile({ runtimeVersion: '2.3.0.401' });
    assert.equal(modern.scriptSemantics, 'global-startup');
    assert.isTrue(modern.supports('constructors'));
    assert.isTrue(modern.supports('exceptions'));
    assert.isFalse(modern.supports('templateStrings'));
    assert.isTrue(modern.supports('delete'));
    assert.isFalse(modern.supports('nullish'));
    assert.isTrue(
      new LanguageProfile({ runtimeVersion: '2.3.7.474' }).supports('nullish'),
    );
    assert.isTrue(
      new LanguageProfile({ runtimeVersion: '2023.4.0.0' }).supports(
        'templateStrings',
      ),
    );
  });

  it('does not invent a target from bundled metadata or an invalid version', function () {
    const profile = new LanguageProfile({
      runtimeVersion: 'unknown',
      specSources: [bundled],
    });
    assert.equal(profile.scriptSemantics, 'unknown');
    assert.isUndefined(profile.supports('functions'));
    assert.isUndefined(profile.supports('templateStrings'));
    assert.equal(profile.versionSource, 'unknown');
  });

  it('uses native base metadata only when no target version is known', function () {
    const profile = new LanguageProfile({
      specSources: [{ ...bundled, bundled: false, runtime: '2023.4.0.0' }],
    });
    assert.equal(profile.versionSource, 'spec');
    assert.isFalse(profile.nativeDegraded);
    assert.isTrue(profile.supports('templateStrings'));
  });

  it('invalidates on native content changes and owns its provenance snapshot', function () {
    const sources = [{ ...bundled }];
    const profile = new LanguageProfile({ specSources: sources });
    const key = profile.key;
    sources[0].sha256 = 'fixture-spec-b';
    assert.equal(profile.key, key);
    assert.notEqual(new LanguageProfile({ specSources: sources }).key, key);
  });
});
