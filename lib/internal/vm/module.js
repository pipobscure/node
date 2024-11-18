'use strict';

const {
  Array,
  ArrayIsArray,
  ArrayPrototypeForEach,
  ArrayPrototypeIndexOf,
  ArrayPrototypeMap,
  ArrayPrototypeSome,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectGetPrototypeOf,
  ObjectPrototypeHasOwnProperty,
  ObjectSetPrototypeOf,
  PromisePrototypeThen,
  PromiseResolve,
  ReflectApply,
  SafePromiseAllReturnArrayLike,
  Set,
  Symbol,
  SymbolToStringTag,
  TypeError,
} = primordials;

const assert = require('internal/assert');
const {
  isModuleNamespaceObject,
} = require('internal/util/types');
const {
  customInspectSymbol,
  emitExperimentalWarning,
  getConstructorOf,
  kEmptyObject,
} = require('internal/util');
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

const binding = internalBinding('module_wrap');
const {
  ModuleWrap,
  kUninstantiated,
  kInstantiating,
  kInstantiated,
  kEvaluating,
  kEvaluated,
  kErrored,
} = binding;

const STATUS_MAP = {
  [kUninstantiated]: 'unlinked',
  [kInstantiating]: 'linking',
  [kInstantiated]: 'linked',
  [kEvaluating]: 'evaluating',
  [kEvaluated]: 'evaluated',
  [kErrored]: 'errored',
};

const defaultModuleName = 'vm:module';

const { isContext } = require('internal/vm');

class Module {
	#identifier;
	#wrapped;
	constructor(identifier, content, options = kEmptyObject) {
		this.#identifier = identifier;
    if (options.context !== undefined && !isContext(options.context)) {
      throw new ERR_INVALID_ARG_TYPE('options.context', 'vm.Context', options.context);
    }
		if ('string' === typeof content) {
			this.#wrapped = new ModuleWrap(identifier, options.context, content, options.lineOffset ?? 0, options.columnOffset ?? 0, options.cachedData);
		} else {
			this.#wrapped = new ModuleWrap(identifier, options.context, content.exportNames, content.evaluationSteps);
		}
	}
	identifier() {
		return this.#identifier;
	}
	status() {
		return STATUS_MAP[this.#wrapped.getStatus()];
	}
	error() {
		if (this.#wrapped.getStatus() !== kErrored) return undefined;
		return this.#wrapped.getError();
	}
	isGraphAsync() {
		return (this.#wrapped.getStatus() === kInstantiated) && this.#wrapped.isGraphAsync();
	}
	get importSpecifiers() {
		const value = Object.freeze(this.#wrapped.getModuleRequests().map((request)=>request.specifier));
		Object.defineProperty(this, 'importSpecifiers', { value, enumerable: true, configurable: true });
    return value;
  }
	get namespace() {
		return this.#wrapped.getNamespaceSync();
	}
	link(imports = kEmptyObject) {
		const names = Object.keys(imports);
		const modules = Object.values(imports);
    if (!new Set(this.importSpecifiers).isSupersetOf(new Set(names))) {
      throw new Error('insufficient imports');
    }
		this.#wrapped.link(names, modules.map(m=>m.#wrapped));
    this.#wrapped.instantiateSync();
	};
	evaluate() {
		if (!this.isGraphAsync()) {
			this.#wrapped.evaluateSync();
		} else {
			return this.#wrapped.evaluate();
		}
	}
	setExport(name, value) {
    if (![ kEvaluating, kEvaluated ].includes(this.#wrapped.getStatus())) throw new Error('module must be linked');
		this.#wrapped.setExport(name, value);
	}
}

module.exports = {
  Module
};
