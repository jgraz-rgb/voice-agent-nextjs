if (typeof window !== 'undefined' && navigator?.mediaDevices?.getUserMedia) {
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = function(constraints: MediaStreamConstraints) {
    if (constraints.audio === true) {
      constraints.audio = {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 1,
      };
    } else if (typeof constraints.audio === 'object') {
      constraints.audio = {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 1,
        ...constraints.audio,
      };
    }
    
    console.log('[Audio Patch] getUserMedia called with constraints:', constraints);
    return originalGetUserMedia(constraints);
  };
}

export {};
