import { requireNativeView } from 'expo';
import * as React from 'react';

import type { VideoEngineViewProps, VideoEngineViewRef } from './VideoEngine.types';

const NativeView: React.ComponentType<
  VideoEngineViewProps & { ref?: React.Ref<VideoEngineViewRef> }
> = requireNativeView('VideoEngine');

/**
 * Native preview surface. Decoding and compositing run on the platform's
 * hardware pipeline (AVFoundation / Media3); JS drives it through the ref.
 */
export default function VideoEngineView({
  ref,
  ...props
}: VideoEngineViewProps & { ref?: React.Ref<VideoEngineViewRef> }) {
  return <NativeView ref={ref} {...props} />;
}
