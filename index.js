// ----------------------------------------------------------------------------
// Util
// ----------------------------------------------------------------------------

//
function hexToUint8Array(hexString) {
  const length = hexString.length / 2;
  const uint8Array = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const byte = parseInt(hexString.substr(i * 2, 2), 16);
    uint8Array[i] = byte;
  }
  return uint8Array;
}

//
function toBase64Url(u8arr) {
  // btoa を使うと Base64 になってしまい、Base64URL でない
  // 適切に置換する
  return btoa(String.fromCharCode.apply(null, u8arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=*$/, '');
}

//
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// ----------------------------------------------------------------------------
// MSE
// ----------------------------------------------------------------------------

// fragmented mp4 を MSE で読み込む。
function setMediaSourceConcatenated(video, assetURL, mimeCodec) {
  if (!MediaSource.isTypeSupported(mimeCodec)) {
    console.error('Unsupported MIME type or codec: ', mimeCodec);
    return;
  }
  const mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener('sourceopen', async () => {
    const sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);

    const res = await fetch(assetURL);
    const arrayBuffer = await res.arrayBuffer();

    sourceBuffer.addEventListener('updateend', () => {
      video.play();
    });
    sourceBuffer.appendBuffer(arrayBuffer);
  });
}

/**
 *
 * @param {*} video
 * @param {[{urls: Array<String>, mimeCodec: String}]} assets
 * @returns
 */
function setMediaSource(video, assets) {
  for (const asset of assets) {
    if (!MediaSource.isTypeSupported(asset.mimeCodec)) {
      console.error('Unsupported MIME type or codec: ', asset.mimeCodec);
      return;
    }
  }
  const mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  mediaSource.addEventListener('sourceopen', () => {
    for (const asset of assets) {
      const sourceBuffer = mediaSource.addSourceBuffer(asset.mimeCodec);
      // null: sourceBuffer can append buffers immediately
      // Array: sourceBuffer is working
      let arrayBuffersQueue = null;
      let fetchingBufferIndex = 0;
      let unorderedArrayBuffersQueue = {};
      const pushArrayBuffers = (ab) => {
        // sourceBufferには1つずつarrayBufferをappendしていく。
        // appendの完了はupdateendで受け取る。
        if (arrayBuffersQueue === null) {
          // sourceBuffer is ready.
          // Append the buffer immediately
          sourceBuffer.appendBuffer(ab);
          arrayBuffersQueue = [];
        } else {
          arrayBuffersQueue.push(ab);
        }
      };
      // arrayBuffersQueue should be sorted.
      // If not in order, keep in unorderedArrayBuffersQueue
      const popFromUnorderedArrayBuffersQueue = () => {
        while (unorderedArrayBuffersQueue[fetchingBufferIndex]) {
          const ab = unorderedArrayBuffersQueue[fetchingBufferIndex];
          unorderedArrayBuffersQueue[fetchingBufferIndex] = undefined;
          delete unorderedArrayBuffersQueue[fetchingBufferIndex];
          pushArrayBuffers(ab);
          fetchingBufferIndex += 1;
        }
      };
      // Fetch all source
      asset.urls.forEach(async (url, index) => {
        const res = await fetch(url);
        const ab = await res.arrayBuffer();
        unorderedArrayBuffersQueue[index] = ab;
        popFromUnorderedArrayBuffersQueue();
      });
      sourceBuffer.addEventListener('updateend', () => {
        video.play();
        if (arrayBuffersQueue !== null && arrayBuffersQueue.length >= 1) {
          // append next buffer.
          const ab = arrayBuffersQueue.shift();
          sourceBuffer.appendBuffer(ab);
        } else {
          // sourceBuffer is ready.
          arrayBuffersQueue = null;
        }
      });
    }
  });
}

// ----------------------------------------------------------------------------
// EME (org.w3.clearkey)
// ----------------------------------------------------------------------------

//
async function createMediaKeysClearKey(videoContentType, audioContentType) {
  const config = [
    {
      label: 'clearkey',
      initDataTypes: ['cenc'],
      distinctiveIdentifier: 'optional',
      persistentState: 'optional',
      sessionTypes: ['temporary'],
      videoCapabilities: [
        {
          contentType: videoContentType,
        },
      ],
      audioCapabilities: [
        {
          contentType: audioContentType,
        },
      ],
    },
  ];

  const keySystemAccess = await navigator.requestMediaKeySystemAccess(
    'org.w3.clearkey',
    config
  );
  const mediaKeys = await keySystemAccess.createMediaKeys();
  return mediaKeys;
}

//
function createSessionClearkey(mediaKeys, encryption_key) {
  const session = mediaKeys.createSession();
  session.addEventListener('message', (event) => {
    // License Request
    const session = event.target;
    const message = event.message;
    handleLicenseRequestClearKey(session, message, encryption_key);
  });
  session.addEventListener('keystatuseschange', (event) => {
    console.log('keystatuschange', event);
  });
  return session;
}

//
async function handleLicenseRequestClearKey(session, message, encryption_key) {
  // No ClearKey license server
  // Response encryption key
  const request = JSON.parse(new TextDecoder().decode(message));
  const response = {
    keys: [
      {
        kty: 'oct',
        alg: 'A128KW',
        use: 'enc',
        kid: request.kids[0], // same as encryption_kid
        k: toBase64Url(encryption_key),
      },
    ],
  };
  console.log('handleLicenseRequestClearKey', request, response);
  const responseRaw = new TextEncoder().encode(JSON.stringify(response));

  session.update(responseRaw).catch((e) => console.error(e));
}

//
function setMediaKeysClearKey(
  video,
  videoContentType,
  audioContentType,
  encryption_key
) {
  (async () => {
    try {
      const mediaKeys = await createMediaKeysClearKey(
        videoContentType,
        audioContentType
      );
      await video.setMediaKeys(mediaKeys);
    } catch (error) {
      console.error('EME setup failed:', error);
    }
  })();

  // 暗号化されたメディアを検知したら呼び出される
  video.addEventListener('encrypted', async (event) => {
    try {
      const { initDataType, initData } = event;
      console.log(
        'encrypted',
        'initDataType=',
        initDataType,
        'initData=',
        toBase64Url(new Uint8Array(initData))
      );
      const mediaKeys = video.mediaKeys;

      // セッションを作成
      const session = createSessionClearkey(mediaKeys, encryption_key);
      await session.generateRequest(initDataType, initData);
    } catch (error) {
      console.error('EME setup failed:', error);
    }
  });
}

// ----------------------------------------------------------------------------
// EME (com.widevine.alpha)
// ----------------------------------------------------------------------------

//
async function createMediaKeysWidevine(videoContentType, audioContentType) {
  const config = [
    {
      label: 'widevine',
      initDataTypes: ['cenc'],
      distinctiveIdentifier: 'optional',
      persistentState: 'optional',
      sessionTypes: ['temporary'],
      videoCapabilities: [
        {
          contentType: videoContentType,
          robustness: '', // SW_SECURE_CRYPTO
        },
      ],
      audioCapabilities: [
        {
          contentType: audioContentType,
          robustness: '', // SW_SECURE_CRYPTO
        },
      ],
    },
  ];

  const keySystemAccess = await navigator.requestMediaKeySystemAccess(
    'com.widevine.alpha',
    config
  );
  const mediaKeys = await keySystemAccess.createMediaKeys();
  return mediaKeys;
}

//
function createSessionWidevine(mediaKeys, licenseServerInfo) {
  const session = mediaKeys.createSession();

  session.addEventListener('message', (event) => {
    console.log('message', event, 'data', event.data);
    // License Request
    const session = event.target;
    const message = event.message;
    handleLicenseRequestWidevine(session, message, licenseServerInfo);
  });
  session.addEventListener('keystatuseschange', (event) => {
    console.log('keystatuschange', event);
  });
  return session;
}

//
async function handleLicenseRequestWidevine(
  session,
  message,
  licenseServerInfo
) {
  // Request to license server
  const headers = new Headers();
  for (const key in licenseServerInfo.httpRequestHeaders) {
    headers.append(key, licenseServerInfo.httpRequestHeaders[key]);
  }
  const response = await fetch(licenseServerInfo.serverURL, {
    headers,
    method: 'POST',
    body: message,
  });
  const buffer = await response.arrayBuffer();

  session.update(buffer).catch((e) => console.error(e));
}

//
function setMediaKeysWidevine(
  video,
  videoContentType,
  audioContentType,
  licenseServerInfo
) {
  (async () => {
    try {
      const mediaKeys = await createMediaKeysWidevine(
        videoContentType,
        audioContentType
      );
      await video.setMediaKeys(mediaKeys);

      // encrypted event を待たず session を開始する
      const session = createSessionWidevine(mediaKeys, licenseServerInfo);
      // set init data as cenc
      await session.generateRequest(
        'cenc',
        base64ToArrayBuffer(licenseServerInfo.cenc_pssh)
      );
    } catch (error) {
      console.error('EME setup failed:', error);
    }
  })();

  // 暗号化されたメディアを検知したら呼び出される。
  // 呼び出されないこともある。
  // コンテナの contentenckeyid が関係するかもしれない。
  video.addEventListener('encrypted', async (event) => {
    const { initDataType, initData } = event;
    console.log(
      'encrypted',
      'initDataType=',
      initDataType,
      'initData=',
      toBase64Url(new Uint8Array(initData))
    );
  });
}
