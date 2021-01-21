// Copyright 2020-2021 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { OnApplicationShutdown } from '@nestjs/common';
import { ApiPromise, WsProvider } from '@polkadot/api';
import {
  ApiOptions,
  QueryableStorageEntry,
  ApiInterfaceRx,
  QueryableStorageMultiArg,
} from '@polkadot/api/types';
import { BlockHash } from '@polkadot/types/interfaces';
import { AnyTuple } from '@polkadot/types/types';
import { combineLatest } from 'rxjs';
import { SubqueryProject } from '../configure/project.model';

const NOT_SUPPORT = (name: string) => () => {
  throw new Error(`${name}() is not supported`);
};

export class ApiService implements OnApplicationShutdown {
  private api: ApiPromise;
  private patchedApi: ApiPromise;
  private currentBlockHash: BlockHash;

  static useFactory = {
    provide: ApiService,
    inject: [SubqueryProject],
    useFactory: async (project: SubqueryProject) => {
      const apiService = new ApiService(project);
      return apiService.init();
    },
  };

  constructor(protected project: SubqueryProject) {}

  async onApplicationShutdown(signal?: string) {
    await Promise.all([this.api?.disconnect(), this.patchedApi?.disconnect()]);
  }

  async init(): Promise<ApiService> {
    const { network } = this.project;
    const apiOption: ApiOptions = {
      provider: new WsProvider(network.endpoint),
    };
    if (network.customTypes) {
      apiOption.types = network.customTypes;
    }
    this.api = await ApiPromise.create(apiOption);
    return this;
  }

  getApi(): ApiPromise {
    return this.api;
  }

  async getPatchedApi(): Promise<ApiPromise> {
    if (this.patchedApi) {
      return this.patchedApi;
    }
    const patchedApi = this.getApi().clone();
    await patchedApi.isReady;
    Object.defineProperty(
      (patchedApi as any)._rpcCore.provider,
      'hasSubscriptions',
      { value: false },
    );
    this.patchedApi = patchedApi;
    this.patchApi();
    return this.patchedApi;
  }

  private patchApi(): void {
    this.patchApiQuery(this.patchedApi);
    this.patchApiTx(this.patchedApi);
    this.patchApiRpc(this.patchedApi);
    this.patchApiQueryMulti(this.patchedApi);
    this.patchDerive(this.patchedApi);
    (this.patchedApi as any).isPatched = true;
  }

  async setBlockhash(blockHash: BlockHash): Promise<void> {
    if (!this.patchedApi) {
      await this.getPatchedApi();
    }
    this.currentBlockHash = blockHash;
    const { metadata, registry } = await this.api.getBlockRegistry(blockHash);
    this.patchedApi.injectMetadata(metadata, true, registry);
    this.patchApi();
  }

  private replaceToAtVersion(
    original: QueryableStorageEntry<'promise' | 'rxjs', AnyTuple>,
    atMethod: string,
  ) {
    return (...args: any[]) => {
      const expandedArgs = original.creator.meta.type.isDoubleMap
        ? args[0]
        : args;
      return original[atMethod](this.currentBlockHash, ...expandedArgs);
    };
  }

  private redecorateStorageEntryFunction(
    original: QueryableStorageEntry<'promise' | 'rxjs', AnyTuple>,
    apiType: 'promise' | 'rxjs',
  ): QueryableStorageEntry<'promise' | 'rxjs', AnyTuple> {
    const newEntryFunc = this.replaceToAtVersion(
      original,
      'at',
    ) as QueryableStorageEntry<'promise' | 'rxjs', AnyTuple>;
    newEntryFunc.at = NOT_SUPPORT('at');
    newEntryFunc.creator = original.creator;
    newEntryFunc.entries = this.replaceToAtVersion(original, 'entriesAt');
    newEntryFunc.entriesAt = NOT_SUPPORT('entriesAt');
    newEntryFunc.entriesPaged = NOT_SUPPORT('entriesPaged');
    newEntryFunc.hash = NOT_SUPPORT('hash');
    newEntryFunc.is = original.is.bind(original);
    newEntryFunc.key = original.key.bind(original);
    newEntryFunc.keyPrefix = original.keyPrefix.bind(original);
    newEntryFunc.keys = this.replaceToAtVersion(original, 'keysAt');
    newEntryFunc.keysAt = NOT_SUPPORT('keysAt');
    newEntryFunc.keysPaged = NOT_SUPPORT('keysPaged');
    if (apiType === 'promise') {
      this.patchPromiseStorageEntryMulti(
        newEntryFunc as QueryableStorageEntry<'promise', AnyTuple>,
      );
    } else {
      this.patchRxStorageEntryMulti(
        newEntryFunc as QueryableStorageEntry<'rxjs', AnyTuple>,
      );
    }
    newEntryFunc.multi = (async (keys: any[]) => {
      return Promise.all(keys.map(async (key) => newEntryFunc(key)));
    }) as any;
    newEntryFunc.range = NOT_SUPPORT('range');
    newEntryFunc.size = this.replaceToAtVersion(original, 'sizeAt');
    newEntryFunc.sizeAt = NOT_SUPPORT('sizeAt');
    return newEntryFunc;
  }

  private patchPromiseStorageEntryMulti(
    newEntryFunc: QueryableStorageEntry<'promise', AnyTuple>,
  ): void {
    newEntryFunc.multi = (async (keys: any[]) =>
      Promise.all(keys.map(async (key) => newEntryFunc(key)))) as any;
  }

  private patchRxStorageEntryMulti(
    newEntryFunc: QueryableStorageEntry<'rxjs', AnyTuple>,
  ): void {
    newEntryFunc.multi = ((keys: any[]) =>
      combineLatest(keys.map((key) => newEntryFunc(key)))) as any;
  }

  private patchApiQuery(api: ApiPromise): void {
    (api as any)._query = Object.entries(api.query).reduce(
      (acc, [module, moduleStorageItems]) => {
        acc[module] = Object.entries(moduleStorageItems).reduce(
          (accInner, [storageName, storageEntry]) => {
            accInner[storageName] = this.redecorateStorageEntryFunction(
              storageEntry,
              'promise',
            );
            return accInner;
          },
          {},
        );
        return acc;
      },
      {},
    );
    (api as any)._rx.query = Object.entries(
      (api as any)._rx.query as ApiInterfaceRx['query'],
    ).reduce((acc, [module, moduleStorageItems]) => {
      acc[module] = Object.entries(moduleStorageItems).reduce(
        (accInner, [storageName, storageEntry]) => {
          accInner[storageName] = this.redecorateStorageEntryFunction(
            storageEntry,
            'rxjs',
          );
          return accInner;
        },
        {},
      );
      return acc;
    }, {});
  }

  private patchApiTx(api: ApiPromise): void {
    (api as any)._extrinsics = Object.entries(api.tx).reduce(
      (acc, [module, moduleExtrinsics]) => {
        acc[module] = Object.entries(moduleExtrinsics).reduce(
          (accInner, [name]) => {
            accInner[name] = NOT_SUPPORT('api.tx.*');
            return accInner;
          },
          {},
        );
        return acc;
      },
      {},
    );
    (api as any)._rx.tx = Object.entries(
      (api as any)._rx.tx as ApiInterfaceRx['tx'],
    ).reduce((acc, [module, moduleExtrinsics]) => {
      acc[module] = Object.entries(moduleExtrinsics).reduce(
        (accInner, [name]) => {
          accInner[name] = NOT_SUPPORT('api.tx.*');
          return accInner;
        },
        {},
      );
      return acc;
    }, {});
  }

  private patchApiRpc(api: ApiPromise): void {
    (api as any)._rpc = Object.entries(api.rpc).reduce(
      (acc, [module, rpcMethods]) => {
        acc[module] = Object.entries(rpcMethods).reduce((accInner, [name]) => {
          accInner[name] = NOT_SUPPORT('api.rpc.*');
          return accInner;
        }, {});
        return acc;
      },
      {},
    );
    (api as any)._rx.rpc = Object.entries(
      (api as any)._rx.rpc as ApiInterfaceRx['rpc'],
    ).reduce((acc, [module, rpcMethods]) => {
      acc[module] = Object.entries(rpcMethods).reduce((accInner, [name]) => {
        accInner[name] = NOT_SUPPORT('api.rpc.*');
        return accInner;
      }, {});
      return acc;
    }, {});
  }

  private patchApiQueryMulti(api: ApiPromise): void {
    (api as any)._queryMulti = async (
      calls: QueryableStorageMultiArg<'promise'>[],
    ) =>
      Promise.all(
        calls.map(async (callMultiArg) => {
          if (callMultiArg instanceof Array) {
            const [storageFunc, ...args] = callMultiArg;
            return storageFunc(...args);
          } else {
            return callMultiArg();
          }
        }),
      );
    (api as any)._rx.queryMulti = (calls: QueryableStorageMultiArg<'rxjs'>[]) =>
      combineLatest(
        calls.map((callMultiArg) => {
          if (callMultiArg instanceof Array) {
            const [storageFunc, ...args] = callMultiArg;
            return storageFunc(...args);
          } else {
            return callMultiArg();
          }
        }),
      );
  }

  private patchDerive(api: ApiPromise): void {
    (api as any)._derive = Object.entries((api as any).derive).reduce(
      (acc, [module, deriveMethods]) => {
        acc[module] = Object.entries(deriveMethods).reduce(
          (accInner, [name]) => {
            accInner[name] = NOT_SUPPORT('api.derive.*');
            return accInner;
          },
          {},
        );
        return acc;
      },
      {},
    );
    (api as any)._rx.derive = Object.entries((api as any)._rx.derive).reduce(
      (acc, [module, deriveMethods]) => {
        acc[module] = Object.entries(deriveMethods).reduce(
          (accInner, [name]) => {
            accInner[name] = NOT_SUPPORT('api.derive.*');
            return accInner;
          },
          {},
        );
        return acc;
      },
      {},
    );
  }
}