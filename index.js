// ----------------------------------------------------------------------------
// Util
// ----------------------------------------------------------------------------

function hexToUint8Array(hexString) {
  const length = hexString.length / 2;
  const uint8Array = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const byte = parseInt(hexString.substr(i * 2, 2), 16);
    uint8Array[i] = byte;
  }
  return uint8Array;
}

function toBase64Url(u8arr) {
  // btoa を使うと Base64 になってしまい、Base64URL でない
  // 適切に置換する
  return btoa(String.fromCharCode.apply(null, u8arr))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=*$/, '');
}

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
      // mediaSource.endOfStream();
      video.play();
      console.log(mediaSource.readyState); // ended
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
      let arrayBuffersQueue = null;
      let fetchingBufferIndex = 0;
      let unorderedArrayBuffersQueue = {};
      const pushArrayBuffers = (ab) => {
        // sourceBufferには1つずつarrayBufferをappendしていく。
        // appendの完了はupdateendで受け取る。
        if (arrayBuffersQueue === null) {
          sourceBuffer.appendBuffer(ab);
          arrayBuffersQueue = [];
        } else {
          arrayBuffersQueue.push(ab);
        }
      };
      const popFromUnorderedArrayBuffersQueue = () => {
        while (unorderedArrayBuffersQueue[fetchingBufferIndex]) {
          const ab = unorderedArrayBuffersQueue[fetchingBufferIndex];
          unorderedArrayBuffersQueue[fetchingBufferIndex] = undefined;
          delete unorderedArrayBuffersQueue[fetchingBufferIndex];
          console.log('pushArrayBuffers' + fetchingBufferIndex);
          pushArrayBuffers(ab);
          fetchingBufferIndex += 1;
        }
      };
      asset.urls.forEach(async (url, index) => {
        const res = await fetch(url);
        const ab = await res.arrayBuffer();
        console.log('fetch' + index);
        unorderedArrayBuffersQueue[index] = ab;
        popFromUnorderedArrayBuffersQueue();
      });
      sourceBuffer.addEventListener('updateend', () => {
        console.log('updateend');
        video.play();
        if (arrayBuffersQueue !== null && arrayBuffersQueue.length >= 1) {
          const ab = arrayBuffersQueue.shift();
          console.log('next..');
          sourceBuffer.appendBuffer(ab);
        } else {
          arrayBuffersQueue = null;
        console.log('wait');
        }
      });
    }
  });
}

// ----------------------------------------------------------------------------
// EME (org.w3.clearkey)
// ----------------------------------------------------------------------------

async function createMediaKeysClearKey(videoContentType, audioContentType) {
  const config = [
    {
      initDataTypes: ['cenc'],
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

async function handleLicenseRequestClearKey(session, message, encryption_key) {
  const request = JSON.parse(new TextDecoder().decode(message));
  // console.log('request:', request);
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
  // console.log('response', response);
  const responseRaw = new TextEncoder().encode(JSON.stringify(response));

  session.update(responseRaw).catch((e) => console.error(e));
}

function setMediaKeysClearKey(video, videoCodec, audioCodec, encryption_key) {
  (async () => {
    try {
      // MediaKey を作成して video にセットする
      const mediaKeys = await createMediaKeysClearKey(
        `video/mp4; codecs="${videoCodec}"`,
        `audio/mp4; codecs="${audioCodec}"`
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
      // console.log(
      //   'onencrypted:',
      //   'initDataType=',
      //   initDataType,
      //   'initData=',
      //   initData
      // );
      const mediaKeys = video.mediaKeys;

      // セッションを作成
      const session = mediaKeys.createSession();
      session.addEventListener('message', (event) => {
        // License Request
        const session = event.target;
        const message = event.message;
        handleLicenseRequestClearKey(session, message, encryption_key);
      });
      await session.generateRequest(initDataType, initData);
    } catch (error) {
      console.error('EME setup failed:', error);
    }
  });
}
// ----------------------------------------------------------------------------
// EME (com.widevine.alpha)
// ----------------------------------------------------------------------------

async function createMediaKeysWidevine(videoContentType, audioContentType) {
  const config = [
    {
      label: 'widevine',
      initDataTypes: ['cenc'],
      "distinctiveIdentifier": "optional",
      persistentState: "optional",
      sessionTypes: ["temporary"],
      videoCapabilities: [
        {
          contentType: videoContentType,
          robustness: '', // SW_SECURE_CRYPTO
        },
      ],
      audioCapabilities: [
        {
          contentType: audioContentType,
          robustness: '',  // SW_SECURE_CRYPTO
        },
      ],
    },
  ];

  const keySystemAccess = await navigator.requestMediaKeySystemAccess(
    'com.widevine.alpha',
    config
  );
  // keySystemAccess.selectedSystemString = 'com.widevine.alpha';  // ??
  const mediaKeys = await keySystemAccess.createMediaKeys();
  return mediaKeys;
}

async function handleLicenseRequestWidevine(session, message, licenseServerInfo) {
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

function setMediaKeysWidevine(video, videoCodec, audioCodec, licenseServerInfo) {
  (async () => {
    try {
      // MediaKey を作成して video にセットする
      const mediaKeys = await createMediaKeysWidevine(
        `video/mp4;codecs="${videoCodec}"`,
        `audio/mp4;codecs="${audioCodec}"`
      );
      await video.setMediaKeys(mediaKeys);
      console.log('setMediaKeys ok');

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

      await session.generateRequest(
        'cenc',
        base64ToArrayBuffer(licenseServerInfo.cenc_pssh)
      );
    } catch (error) {
      console.error('EME setup failed:', error);
    }
  })();

  // 暗号化されたメディアを検知したら呼び出される
  video.addEventListener('encrypted', async (event) => {
    console.log('encrypted');
    // onencrypted しないことがある
    // コンテナの contentenckeyid が関係するか？ 
  });
}