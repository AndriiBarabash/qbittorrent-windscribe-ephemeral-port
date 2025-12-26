import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

// Set to true to save debug images and logs
const DEBUG_CAPTCHA = process.env.DEBUG_CAPTCHA === 'true';

// Debug context for collecting log messages
interface DebugContext {
  timestamp: number;
  logs: string[];
}

let debugContext: DebugContext | null = null;

function debugLog(message: string): void {
  console.log(message);
  if (debugContext) {
    debugContext.logs.push(message);
  }
}

function saveDebugLogs(): void {
  if (debugContext && DEBUG_CAPTCHA) {
    const debugDir = path.join(process.cwd(), 'captcha_debug');
    const logPath = path.join(debugDir, `${debugContext.timestamp}_debug.txt`);
    const content = [
      `CAPTCHA Debug Log`,
      `Timestamp: ${new Date(debugContext.timestamp).toISOString()}`,
      ``,
      ...debugContext.logs
    ].join('\n');
    fs.writeFileSync(logPath, content);
    console.log(`Debug log saved to ${logPath}`);
  }
}

interface CaptchaData {
  background: string; // base64 encoded PNG
  slider?: string;    // base64 encoded PNG (puzzle piece) - may not be present
  top: number;        // vertical position of the piece
}

interface CaptchaSolution {
  offset: number;
  trail: {
    x: number[];
    y: number[];
  };
}

/**
 * Solves Windscribe's slider CAPTCHA by finding where the puzzle piece fits
 * in the background image using edge-based template matching.
 */
export async function solveCaptcha(captchaData: CaptchaData): Promise<CaptchaSolution> {
  // Initialize debug context
  const timestamp = Date.now();
  if (DEBUG_CAPTCHA) {
    debugContext = { timestamp, logs: [] };
  }

  try {
    // Decode base64 background image
    const bgBuffer = Buffer.from(
      captchaData.background.replace(/^data:image\/\w+;base64,/, ''),
      'base64'
    );

    let offset: number;

    if (captchaData.slider && captchaData.slider !== captchaData.background) {
      // If we have a separate slider image, use template matching
      const sliderBuffer = Buffer.from(
        captchaData.slider.replace(/^data:image\/\w+;base64,/, ''),
        'base64'
      );

      // Save debug images if enabled
      if (DEBUG_CAPTCHA) {
        const debugDir = path.join(process.cwd(), 'captcha_debug');
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }
        fs.writeFileSync(path.join(debugDir, `${timestamp}_background.png`), bgBuffer);
        fs.writeFileSync(path.join(debugDir, `${timestamp}_slider.png`), sliderBuffer);
        debugLog(`Debug images saved to ${debugDir}/${timestamp}_*.png`);
        debugLog(`CAPTCHA top offset: ${captchaData.top}`);
      }

      offset = await findSliderOffsetWithTemplate(bgBuffer, sliderBuffer, captchaData.top);
    } else {
      // No separate slider - find the shadow/cutout in the background
      if (DEBUG_CAPTCHA) {
        debugLog(`No separate slider image, using cutout detection`);
        debugLog(`CAPTCHA top offset: ${captchaData.top}`);
      }
      offset = await findCutoutPosition(bgBuffer, captchaData.top);
    }

    // Generate human-like mouse trail
    const trail = generateMouseTrail(offset);

    if (DEBUG_CAPTCHA) {
      debugLog(`Final solution: offset=${offset}`);
      debugLog(`Mouse trail length: ${trail.x.length} points`);
    }

    return { offset, trail };
  } finally {
    // Always save debug logs at the end
    saveDebugLogs();
    debugContext = null;
  }
}

/**
 * Find the horizontal offset where the slider piece fits in the background
 * using multiple detection strategies.
 */
async function findSliderOffsetWithTemplate(
  bgBuffer: Buffer,
  sliderBuffer: Buffer,
  topOffset: number
): Promise<number> {
  const bgImage = sharp(bgBuffer);
  const sliderImage = sharp(sliderBuffer);

  const bgMeta = await bgImage.metadata();
  const sliderMeta = await sliderImage.metadata();

  // Get background as grayscale
  const bgGray = await bgImage
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Get slider with alpha channel to find the puzzle piece shape
  const sliderRGBA = await sliderImage
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bgWidth = bgMeta.width!;
  const bgHeight = bgMeta.height!;
  const sliderWidth = sliderMeta.width!;
  const sliderHeight = sliderMeta.height!;

  // Find where the white outline target matches the puzzle piece edges
  const targetOffset = findTargetOutline(
    bgGray.data,
    bgWidth,
    bgHeight,
    sliderRGBA.data,
    sliderWidth,
    sliderHeight,
    topOffset
  );

  if (DEBUG_CAPTCHA) {
    debugLog(`Target outline detection offset: ${targetOffset}`);
  }

  return targetOffset;
}

/**
 * Find the white outlined target region in the background that matches the puzzle piece.
 * The target is marked with a thin white border outline.
 *
 * Strategy: Find the left edge of the white rectangular outline by looking for
 * vertical lines of bright pixels, then verify by checking for a complete rectangle.
 */
function findTargetOutline(
  bgPixels: Buffer,
  bgWidth: number,
  bgHeight: number,
  sliderRGBA: Buffer,
  sliderWidth: number,
  sliderHeight: number,
  topOffset: number
): number {
  // First pass: find the bounding box of the puzzle piece using alpha channel
  let minX = sliderWidth, maxX = 0, minY = sliderHeight, maxY = 0;

  for (let y = 0; y < sliderHeight; y++) {
    for (let x = 0; x < sliderWidth; x++) {
      const idx = (y * sliderWidth + x) * 4;
      const alpha = sliderRGBA[idx + 3];
      if (alpha > 128) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const pieceWidth = maxX - minX + 1;
  const pieceHeight = maxY - minY + 1;

  if (DEBUG_CAPTCHA) {
    debugLog(`Puzzle piece bounds: x=${minX}-${maxX}, y=${minY}-${maxY}, size=${pieceWidth}x${pieceHeight}`);
    debugLog(`topOffset from CAPTCHA data: ${topOffset}`);
    debugLog(`Background size: ${bgWidth}x${bgHeight}`);
  }

  // Strategy: Find the white rectangular outline in the background directly.
  // The outline is a thin (1-3 pixel) white border. We'll look for vertical
  // lines of bright pixels that span a significant portion of the expected height.

  const searchStartX = Math.floor(bgWidth * 0.3); // Target is typically on right side
  const searchEndX = bgWidth - 50;

  // Expected vertical span of the target outline
  const expectedTop = topOffset;
  const expectedBottom = Math.min(bgHeight - 1, topOffset + pieceHeight);
  const expectedHeight = expectedBottom - expectedTop;

  if (DEBUG_CAPTCHA) {
    debugLog(`Searching for outline in x=${searchStartX}-${searchEndX}, y=${expectedTop}-${expectedBottom}`);
  }

  // Scan each column for bright pixels that could be part of the left edge
  // We're looking for a vertical line of bright pixels
  const columnScores: { x: number; score: number; brightPixels: number }[] = [];

  for (let x = searchStartX; x < searchEndX; x++) {
    let brightPixelCount = 0;
    let totalBrightness = 0;

    // Check this column in the expected vertical range
    for (let y = expectedTop; y <= expectedBottom; y++) {
      if (y >= 0 && y < bgHeight) {
        const brightness = bgPixels[y * bgWidth + x];
        if (brightness > 150) { // Lower threshold to catch the outline
          brightPixelCount++;
          totalBrightness += brightness;
        }
      }
    }

    // Score based on how many bright pixels in this column (vertical line detection)
    columnScores.push({ x, score: totalBrightness, brightPixels: brightPixelCount });
  }

  // Find columns with significant bright pixel counts (potential vertical edges)
  const significantColumns = columnScores
    .filter(c => c.brightPixels > expectedHeight * 0.1) // At least 10% of expected height
    .sort((a, b) => b.brightPixels - a.brightPixels);

  if (DEBUG_CAPTCHA) {
    debugLog(`Top 10 columns by bright pixel count: ${JSON.stringify(significantColumns.slice(0, 10))}`);
  }

  // Strategy: Find pairs of vertical edges that could form left and right sides of the outline
  // The target is a rectangle, so we expect two vertical edges roughly pieceWidth apart
  // We want the LEFT edge of the pair

  // Sort by x position to find edge pairs
  const sortedByX = [...significantColumns].sort((a, b) => a.x - b.x);

  if (DEBUG_CAPTCHA) {
    debugLog(`Columns sorted by X position: ${JSON.stringify(sortedByX.slice(0, 10).map(c => ({ x: c.x, bright: c.brightPixels })))}`);
  }

  // Look for pairs of edges that are approximately pieceWidth apart
  const edgePairs: { left: number; right: number; score: number }[] = [];

  for (let i = 0; i < sortedByX.length; i++) {
    for (let j = i + 1; j < sortedByX.length; j++) {
      const leftEdge = sortedByX[i];
      const rightEdge = sortedByX[j];
      const distance = rightEdge.x - leftEdge.x;

      // The distance should be close to pieceWidth (allow some tolerance)
      const expectedDistance = pieceWidth;
      const tolerance = pieceWidth * 0.3; // 30% tolerance

      if (Math.abs(distance - expectedDistance) < tolerance) {
        // Good candidate pair
        const pairScore = leftEdge.brightPixels + rightEdge.brightPixels;
        edgePairs.push({ left: leftEdge.x, right: rightEdge.x, score: pairScore });
      }
    }
  }

  if (DEBUG_CAPTCHA) {
    debugLog(`Found ${edgePairs.length} edge pairs with correct spacing`);
    if (edgePairs.length > 0) {
      debugLog(`Top edge pairs: ${JSON.stringify(edgePairs.slice(0, 5))}`);
    }
  }

  let bestLeftEdge = Math.floor(bgWidth * 0.5);
  let bestScore = 0;

  if (edgePairs.length > 0) {
    // Pick the pair with highest combined score
    const bestPair = edgePairs.sort((a, b) => b.score - a.score)[0];
    bestLeftEdge = bestPair.left;
    bestScore = bestPair.score;

    if (DEBUG_CAPTCHA) {
      debugLog(`Best edge pair: left=${bestPair.left}, right=${bestPair.right}, score=${bestPair.score}`);
    }
  } else {
    // Fallback: use the leftmost significant column
    if (sortedByX.length > 0) {
      bestLeftEdge = sortedByX[0].x;
      bestScore = sortedByX[0].brightPixels;

      if (DEBUG_CAPTCHA) {
        debugLog(`No pairs found, using leftmost significant column: x=${bestLeftEdge}`);
      }
    }
  }

  // Verify with horizontal edge detection
  let topEdgeBonus = 0;
  for (let dx = 0; dx < Math.min(pieceWidth, 50); dx++) {
    const checkX = bestLeftEdge + dx;
    if (checkX < bgWidth && expectedTop >= 0 && expectedTop < bgHeight) {
      const brightness = bgPixels[expectedTop * bgWidth + checkX];
      if (brightness > 150) {
        topEdgeBonus++;
      }
    }
  }

  let bottomEdgeBonus = 0;
  for (let dx = 0; dx < Math.min(pieceWidth, 50); dx++) {
    const checkX = bestLeftEdge + dx;
    if (checkX < bgWidth && expectedBottom >= 0 && expectedBottom < bgHeight) {
      const brightness = bgPixels[expectedBottom * bgWidth + checkX];
      if (brightness > 150) {
        bottomEdgeBonus++;
      }
    }
  }

  if (DEBUG_CAPTCHA) {
    debugLog(`Best left edge x=${bestLeftEdge}: topEdgeBonus=${topEdgeBonus}, bottomEdgeBonus=${bottomEdgeBonus}`);
  }

  // The drag offset is from the slider's starting position to align with the target
  // The slider piece content starts at minX within the slider image
  // So we need to drag by: (target left edge) - minX
  const dragOffset = bestLeftEdge - minX;

  if (DEBUG_CAPTCHA) {
    debugLog(`Final drag offset: ${bestLeftEdge} - ${minX} = ${dragOffset}`);
  }

  return dragOffset;
}

/**
 * Find the cutout/shadow position in the background image.
 * This is used when there's no separate slider image - we look for
 * a darker rectangular region (the shadow) or sharp edge discontinuity.
 */
async function findCutoutPosition(
  bgBuffer: Buffer,
  topOffset: number
): Promise<number> {
  const bgImage = sharp(bgBuffer);
  const bgMeta = await bgImage.metadata();
  const width = bgMeta.width!;
  const height = bgMeta.height!;

  // Get raw RGBA pixel data
  const { data } = await bgImage
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Look for areas with strong vertical edges (the cutout boundaries)
  // We search in a horizontal band around the topOffset position
  const searchStartY = Math.max(0, topOffset - 10);
  const searchEndY = Math.min(height, topOffset + 70); // Puzzle piece is typically ~60px tall

  // Calculate vertical edge strength at each x position
  const edgeStrength: number[] = new Array(width).fill(0);

  for (let y = searchStartY; y < searchEndY; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const idxLeft = (y * width + (x - 1)) * 4;
      const idxRight = (y * width + (x + 1)) * 4;

      // Calculate brightness
      const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      const brightnessLeft = (data[idxLeft] + data[idxLeft + 1] + data[idxLeft + 2]) / 3;
      const brightnessRight = (data[idxRight] + data[idxRight + 1] + data[idxRight + 2]) / 3;

      // Edge detection: look for sudden brightness changes
      const edgeL = Math.abs(brightness - brightnessLeft);
      const edgeR = Math.abs(brightness - brightnessRight);

      edgeStrength[x] += edgeL + edgeR;
    }
  }

  // Find the position with maximum edge strength in the valid range
  // The cutout is typically on the right side (puzzle piece starts from left)
  let maxStrength = 0;
  let bestX = Math.floor(width * 0.5); // Default to middle

  // Search from 30% to 90% of width (cutout is usually not at edges)
  const searchStartX = Math.floor(width * 0.3);
  const searchEndX = Math.floor(width * 0.9);

  for (let x = searchStartX; x < searchEndX; x++) {
    // Look for a pattern: low-high-low edge strength indicating cutout boundaries
    const windowStrength = edgeStrength[x] + edgeStrength[x + 1] + edgeStrength[x + 2];
    if (windowStrength > maxStrength) {
      maxStrength = windowStrength;
      bestX = x;
    }
  }

  // The piece needs to slide TO this position, so this is our offset
  if (DEBUG_CAPTCHA) {
    debugLog(`Cutout detection: found position at x=${bestX}`);
  }
  return bestX;
}

/**
 * Simple Sobel edge detection
 */
function sobelEdgeDetection(
  pixels: Buffer,
  width: number,
  height: number
): Float32Array {
  const edges = new Float32Array(width * height);

  // Sobel kernels
  const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0;
      let gy = 0;

      // Apply 3x3 kernel
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = (y + ky) * width + (x + kx);
          const kernelIdx = (ky + 1) * 3 + (kx + 1);
          const pixel = pixels[idx];
          gx += pixel * sobelX[kernelIdx];
          gy += pixel * sobelY[kernelIdx];
        }
      }

      // Gradient magnitude
      edges[y * width + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  return edges;
}

/**
 * Template matching using normalized cross-correlation on edge images.
 * Searches for the best horizontal position where the slider matches the background.
 */
function templateMatch(
  bgEdges: Float32Array,
  bgWidth: number,
  bgHeight: number,
  sliderEdges: Float32Array,
  sliderWidth: number,
  sliderHeight: number,
  topOffset: number
): number {
  let bestOffset = 0;
  let bestScore = -Infinity;

  // Only search right side of the image (piece won't be at the start)
  // Start from a reasonable offset (e.g., 40 pixels in) to avoid false matches at left edge
  const startX = 40;
  const endX = bgWidth - sliderWidth;

  for (let x = startX; x < endX; x++) {
    let score = 0;
    let templateSum = 0;
    let bgSum = 0;

    // Compare slider edges with background at this position
    for (let sy = 0; sy < sliderHeight; sy++) {
      for (let sx = 0; sx < sliderWidth; sx++) {
        const sliderIdx = sy * sliderWidth + sx;
        const bgIdx = (topOffset + sy) * bgWidth + (x + sx);

        if (bgIdx >= 0 && bgIdx < bgEdges.length) {
          const sliderVal = sliderEdges[sliderIdx];
          const bgVal = bgEdges[bgIdx];

          // For edge matching, look for areas where slider has edges
          // and background has matching edge patterns (the cutout)
          if (sliderVal > 30) { // Only consider significant edges
            score += sliderVal * bgVal;
            templateSum += sliderVal * sliderVal;
            bgSum += bgVal * bgVal;
          }
        }
      }
    }

    // Normalized score
    const normalizer = Math.sqrt(templateSum * bgSum);
    if (normalizer > 0) {
      score /= normalizer;
    }

    if (score > bestScore) {
      bestScore = score;
      bestOffset = x;
    }
  }

  return bestOffset;
}

/**
 * Generate a human-like mouse trail from 0 to the target offset.
 * Simulates natural mouse movement with slight variations.
 */
function generateMouseTrail(targetOffset: number): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];

  // Number of sample points (every 5th movement is recorded per the JS)
  const numPoints = Math.max(10, Math.floor(targetOffset / 8));

  // Start position
  let currentX = 0;
  let currentY = 0;

  // Human-like movement parameters
  const avgSpeed = targetOffset / numPoints;

  for (let i = 0; i < numPoints; i++) {
    // Progress from 0 to 1
    const progress = (i + 1) / numPoints;

    // Ease-out curve for natural deceleration
    const easeProgress = 1 - Math.pow(1 - progress, 2);

    // Target position with some overshoot near the end
    const targetX = Math.round(targetOffset * easeProgress);

    // Add some random jitter (humans aren't perfectly smooth)
    const jitterX = Math.round((Math.random() - 0.5) * 3);
    const jitterY = Math.round((Math.random() - 0.5) * 8);

    currentX = Math.max(0, Math.min(targetOffset, targetX + jitterX));
    currentY = jitterY;

    x.push(currentX);
    y.push(currentY);
  }

  // Ensure final position is at target
  x[x.length - 1] = targetOffset;
  y[y.length - 1] = 0;

  return { x, y };
}
