const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const logoPath = './logo.png';

// iOS icon sizes
const iosIcons = [
  { size: 20, scales: [1, 2, 3] },
  { size: 29, scales: [1, 2, 3] },
  { size: 40, scales: [1, 2, 3] },
  { size: 60, scales: [2, 3] },
  { size: 76, scales: [1, 2] },
  { size: 83.5, scales: [2] },
  { size: 1024, scales: [1] }
];

// Android icon sizes
const androidIcons = [
  { name: 'mdpi', size: 48 },
  { name: 'hdpi', size: 72 },
  { name: 'xhdpi', size: 96 },
  { name: 'xxhdpi', size: 144 },
  { name: 'xxxhdpi', size: 192 }
];

async function generateIcons() {
  console.log('Generating app icons...');
  
  // iOS icons
  const iosDir = './ios/App/App/Assets.xcassets/AppIcon.appiconset';
  if (fs.existsSync(iosDir)) {
    for (const icon of iosIcons) {
      for (const scale of icon.scales) {
        const size = Math.round(icon.size * scale);
        const filename = `AppIcon-${icon.size}x${icon.size}@${scale}x.png`;
        await sharp(logoPath)
          .resize(size, size)
          .png()
          .toFile(path.join(iosDir, filename));
        console.log(`Generated iOS: ${filename}`);
      }
    }
    
    // Generate Contents.json for iOS
    const contents = {
      images: [],
      info: { version: 1, author: 'xcode' }
    };
    
    for (const icon of iosIcons) {
      for (const scale of icon.scales) {
        contents.images.push({
          size: `${icon.size}x${icon.size}`,
          idiom: icon.size === 1024 ? 'ios-marketing' : (icon.size >= 76 ? 'ipad' : 'iphone'),
          filename: `AppIcon-${icon.size}x${icon.size}@${scale}x.png`,
          scale: `${scale}x`
        });
      }
    }
    
    fs.writeFileSync(path.join(iosDir, 'Contents.json'), JSON.stringify(contents, null, 2));
  }
  
  // Android icons
  for (const icon of androidIcons) {
    const androidDir = `./android/app/src/main/res/mipmap-${icon.name}`;
    if (fs.existsSync(androidDir)) {
      await sharp(logoPath)
        .resize(icon.size, icon.size)
        .png()
        .toFile(path.join(androidDir, 'ic_launcher.png'));
      
      // Round icon
      await sharp(logoPath)
        .resize(icon.size, icon.size)
        .png()
        .toFile(path.join(androidDir, 'ic_launcher_round.png'));
      
      // Foreground for adaptive icons
      await sharp(logoPath)
        .resize(icon.size, icon.size)
        .png()
        .toFile(path.join(androidDir, 'ic_launcher_foreground.png'));
      
      console.log(`Generated Android: ${icon.name}`);
    }
  }
  
  // Web icons
  await sharp(logoPath).resize(192, 192).png().toFile('./dist/icon-192.png');
  await sharp(logoPath).resize(512, 512).png().toFile('./dist/icon-512.png');
  console.log('Generated web icons');
  
  console.log('Done!');
}

generateIcons().catch(console.error);
