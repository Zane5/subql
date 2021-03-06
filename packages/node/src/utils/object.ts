// Copyright 2020-2021 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { assignWith, isUndefined } from 'lodash';

export function assign<TObject, TSource1, TSource2>(
  target: TObject,
  src: TSource1,
  src2?: TSource2,
): TObject & TSource1 & TSource2 {
  return assignWith(target, src, src2, (objValue, srcValue) =>
    isUndefined(srcValue) ? objValue : srcValue,
  );
}
