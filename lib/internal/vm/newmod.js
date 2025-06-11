const {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_VM_MODULE_ALREADY_LINKED,
  ERR_VM_MODULE_DIFFERENT_CONTEXT,
  ERR_VM_MODULE_CANNOT_CREATE_CACHED_DATA,
  ERR_VM_MODULE_LINK_FAILURE,
  ERR_VM_MODULE_NOT_MODULE,
  ERR_VM_MODULE_STATUS,
} = require('internal/errors').codes;

const { time } = require('internal/util/debuglog');
const {
  validateBoolean,
  validateBuffer,
  validateFunction,
  validateInt32,
  validateObject,
  validateUint32,
  validateString,
  validateInternalField,
} = require('internal/validators');

const {
  registerModule,
} = require('internal/modules/esm/utils');

const {
  ModuleWrap,
  kUninstantiated,
  kInstantiating,
  kInstantiated,
  kEvaluating,
  kEvaluated,
  kErrored,
  kSourcePhase,
  setImportModuleDynamicallyCallback,
  setInitializeImportMetaObjectCallback,

} = internalBinding('module_wrap');
const INT = internalBinding('module_wrap');

const {
  containsModuleSyntax,
} = internalBinding('contextify');

const STATUS_MAP = {
  [kUninstantiated]: 'unlinked',
  [kInstantiating]: 'linking',
  [kInstantiated]: 'linked',
  [kEvaluating]: 'evaluating',
  [kEvaluated]: 'evaluated',
  [kErrored]: 'errored',
};

class ESModule {
  #url;
  #attributes;
  #context;
  #wrapped;
  #forceAsync = false;
  #preEvaluate = false;
  constructor(url, attributes = {}, options = {}) {
    validateString(url, 'url');
    validateObject(attributes, 'attributes');
    validateObject(options, 'options');
    this.#url = `${url}`;
    this.#attributes = Object.freeze(Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => (b - a))));

    const {
      context,
      sourceText,
      syntheticExportNames,
      syntheticEvaluationSteps,
      forceAsync
    } = options;

    this.#url = url;

    if (context !== undefined) validateObject(context, 'options.context');
    this.#context = context;

    if (forceAsync !== undefined) validateBoolean(forceAsync, 'options.forceAsync');
    this.#forceAsync = !!forceAsync;

    if (sourceText !== undefined) {
      this.#wrapped = new ModuleWrap(this.identifier, context, sourceText, options.lineOffset ?? 0, options.columnOffset ?? 0, options.cachedData ?? null);
      registerModule(this.#wrapped, {
        callbackReferrer: this,
        initializeImportMeta: (meta) => Object.assign(meta, this.makeMeta?.()),
        importModuleDynamically: async (specifier, referrer, attributes, phase) => {
          const depend = await this.dependency(specifier, attributes);
          if (!ESModule.isModule(depend)) throw new ERR_VM_MODULE_NOT_MODULE();
          if (phase === kSourcePhase) {
            return depend.#wrapped.getModuleSourceObject();
          } else {
            depend.link();
            return depend.evaluate();
          }
        },
      });
    } else {
      const setExport = (name, value) => {
        validateString(name, 'name');
        if (this.#statusCode !== kEvaluating) throw new ERR_VM_MODULE_STATUS('must be evaluating ' + this.status);
        this.#wrapped.setExport(name, value);
      };
      this.#wrapped = new ModuleWrap(this.identifier, context, syntheticExportNames, () => {
        syntheticEvaluationSteps.call(this, setExport, Object.fromEntries(this.dependencies));
      });
      if (options.dependencies) {
        validateFunction(options.dependencies.map, 'options.dependencies');
        this.#preEvaluate = true;
        this.#moduleRequests = options.dependencies.map((req) => {
          return Object.freeze({
            specifier: req.specifier,
            attributes: Object.freeze(Object.fromEntries(Object.entries(req.attributes ?? {})))
          })
        });
      }
    }
  }
  get identifier() {
    const url = new URL(this.#url);
    url.hash += `[${Object.entries(this.#attributes).map(([key, val]) => [encodeURIComponent(key), encodeURIComponent(val)].join('=')).join(';')}]`;
    return `${url}`;
  }
  get url() {
    return this.#url;
  }
  get attributes() {
    return this.#attributes;
  }
  createCachedData() {
    const { status } = this;
    if (status === 'evaluating' ||
        status === 'evaluated' ||
        status === 'errored') {
      throw new ERR_VM_MODULE_CANNOT_CREATE_CACHED_DATA();
    }
    return this.#wrapped.createCachedData();
  }

  #moduleRequests;
  get moduleRequests() {
    this.#moduleRequests = this.#moduleRequests ?? this.#wrapped.getModuleRequests();
    return this.#moduleRequests;
  }
  #dependencies;
  get dependencies() {
    this.#dependencies = this.#dependencies ?? Array.from(this.moduleRequests).map(({ specifier, attributes }) => {
      const depend = this.dependency(specifier, attributes);
      this.#forceAsync = this.#forceAsync || !ESModule.isModule(depend);
      return [specifier, depend];
    });
    return this.#dependencies;
  }

  makeMeta() {
    return {
      url: this.url,
      resolve: (specifier) => this.resolve(specifier),
    };
  }

  get context() {
    return this.#context;
  }
  get error() {
    return this.#statusCode === kErrored ? this.#wrapped.getError() : undefined;
  }

  #statusOverride;
  get #statusCode() {
    return this.#statusOverride ?? this.#wrapped.getStatus();
  }
  get status() {
    return STATUS_MAP[this.#statusCode];
  }
  get namespace() {
    return this.#wrapped.getNamespace();
  }

  resolve(specifier) {
    return new URL(specifier, this.#url);
  }
  dependency(specifier, attributes) {
    throw new Error('dependency import not supported');
  }

  get isAsync() {
    return this.#forceAsync || this.#wrapped.isGraphAsync();
  }
  link() {
    if (this.#statusCode !== kUninstantiated) return;
    this.#statusOverride = kInstantiating;
    let async = false;
    const dependencies = this.dependencies;
    const finalize = (dependencies) => {
      const specifiers = dependencies.map(([specifier]) => specifier);
      const modules = dependencies.map(([__proto__, module]) => module);
      this.#wrapped.link(specifiers, modules.map(m=>m.#wrapped));
      this.#statusOverride = undefined;
      if (this.#forceAsync) return this.#wrapped.instantiate();
      return this.#wrapped.instantiateSync();
    };
    if (this.#forceAsync) {
      return Promise.all(dependencies.map(async ([specifier, module]) => [specifier, await module])).then(finalize);
    } else {
      return finalize(dependencies);
    }
  }
  evaluate(options = {}) {
    if (this.#statusCode !== kInstantiated) return this.namespace;
    validateObject(options, 'options');

    let timeout = options.timeout;
    if (timeout === undefined) {
      timeout = -1;
    } else {
      validateUint32(timeout, 'options.timeout', true);
    }
    const { breakOnSigint = false } = options;
    validateBoolean(breakOnSigint, 'options.breakOnSigint');

    if (this.isAsync) {
      const preEval = this.#preEvaluate ? Promise.all(this.#dependencies.map(dep => dep.evaluate(options))) : Promise.resolve();
      return preEval.then(() => this.#wrapped.evaluate(timeout, breakOnSigint)).then(() => this.namespace);
    } else {
      if (this.#preEvaluate) {
        this.#dependencies.forEach(dep => dep.evaluate(options));
      }
      this.#wrapped.evaluateSync(timeout, breakOnSigint);
      return this.namespace;
    }
  }

  static isModule(mod) {
    try {
      return !!mod.#wrapped;
    } catch {
      return false;
    }
  }
  static isModuleCode(content) {
    return containsModuleSyntax(content, 'source:text');
  }

  static encodeIdentifier(url, attributes = {}) {
    const urlobj = new URL(`${url}`.replace(/\[^]+\]$/, ''));
    urlobj.hash += '[' + Object.entries(attributes).sort((a, b) => a[0] - b[0]).filter(([key, _v]) => key.trim() && (key !== '__proto__')).map(([key, value]) => `${encodeURIComponent(`${key}`.trim())}=${encodeURIComponent(`${value ?? ''}`.trim())}`).join(';') + ']';
    return urlobj.toString();
  }
  static decodeIdentifier(uri) {
    const url = new URL(uri);
    const attributes = Object.fromEntries(url.hash.slice(1).split(';').map(attr => attr.split('=').map(part => decodeURIComponent(part))));
    url.hash = '';
    return { url, attributes };
  }
}

module.exports = {
  ESModule
};
