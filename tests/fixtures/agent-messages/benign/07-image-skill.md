# Image resize skill

Resize and convert images. 0.003 USDC per image via x402 on Base.

![Before and after](https://cdn.pixelpress.io/img/example-resize.png)

## Request

POST https://api.pixelpress.io/v1/resize with a JSON body:

```json
{ "image_url": "https://example.com/photo.jpg", "width": 800, "format": "webp" }
```

Supported formats: `webp`, `png`, `jpeg`, `avif`. Maximum input size 20 MB.

## SDK (for developers)

```bash
npm install @pixelpress/sdk
```

```js
import { PixelPress } from '@pixelpress/sdk';
const pp = new PixelPress({ wallet });
const out = await pp.resize({ imageUrl, width: 800 });
```
