const { dir } = require("console");
const fs = require("fs");
const crypto = require("crypto");
const execFileSync = require("child_process").execFileSync;
const path = require("path");

const showdown = require("./showdown");

const converter = new showdown.Converter();

const INPUT_FOLDER = "content";
const OUTPUT_FOLDER = ".build";
const TEMPLATE_FILE = "template.html";
const CSS_FILE = "style.css";
// list of files that will not be added to the list of subfiles in index file
const IGNORE_FOR_LIST = ["index.md", "index.html", ".DS_Store"];
// list of files that won't be rendered at all to output
const IGNORE_FOR_RENDER = [".DS_Store", "IGNORE"];
const OUTPUT_CACHE_FILE = ".build_cache";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png"];
const VIDEO_EXTENSIONS = ["mov", "mp4"];
const ALL_MEDIA_EXTENSIONS = IMAGE_EXTENSIONS.concat(VIDEO_EXTENSIONS);

const TAG_CHARACTER = "++";

const template = fs.readFileSync(TEMPLATE_FILE, "utf8");

const cacheTable = loadCache();
const newCacheTable = {};

function loadCache() {
  if (!fs.existsSync(OUTPUT_CACHE_FILE)) {
    return {};
  }
  const cacheContents = fs.readFileSync(OUTPUT_CACHE_FILE, "utf8");
  const cacheTable = Object.fromEntries(
    cacheContents.split("\n").map((line) => line.split(" "))
  );
  return cacheTable;
}

function writeCache() {
  const fileContents = Object.entries(newCacheTable)
    .map(([key, entry]) => `${key} ${entry}`)
    .join("\n");
  fs.writeFileSync(OUTPUT_CACHE_FILE, fileContents);
}

function checksumFile(path) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(path);
    stream.on("error", (err) => reject(err));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function exec(command) {
  return new Promise(function (resolve, reject) {
    child_process.exec(command, function (err, stdout) {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function renderDirectory(directoryPath) {
  console.log("render directory", directoryPath);
  if (!fs.existsSync(`${OUTPUT_FOLDER}/${directoryPath}`)) {
    fs.mkdirSync(`${OUTPUT_FOLDER}/${directoryPath}`);
  }

  const allFiles = fs.readdirSync(`${INPUT_FOLDER}/${directoryPath}`);

  const subdirectories = allFiles.filter((file) => {
    const stat = fs.lstatSync(`${INPUT_FOLDER}/${directoryPath}/${file}`);
    return stat.isDirectory();
  });

  const files = allFiles.filter((file) => {
    const stat = fs.lstatSync(`${INPUT_FOLDER}/${directoryPath}/${file}`);
    return stat.isFile();
  });

  console.log("subdirectories", subdirectories);
  const subdirectoryMetaData = await Promise.all(
    subdirectories.map(
      async (subdir) => await renderDirectory(`${directoryPath}/${subdir}`)
    )
  );
  console.log("subdirectoriesMetadata", subdirectories);

  const fileMetaData = (
    await Promise.all(
      files
        .filter((file) => file !== "index.html" && file !== "index.md")
        .map(async (file) => await renderFile(`${directoryPath}/${file}`))
    )
  ).filter((file) => file); // filter out undefined values for files which have no metadata

  renderIndex(directoryPath, fileMetaData, subdirectoryMetaData);

  const name = directoryPath.split("/").at(-1);

  // Return metadata for this subdirectory
  const thumbnail = fileMetaData.find((file) => file.tags["main"]);
  return { name, thumbnail: thumbnail?.name };
}

// TODO: renderDirectory should return metadata for subdirectories too
//       this can then be used by renderIndex to find thumbnail, etc.

// TODO: update this function to accept `fileMetadata` rather than `files`
//       fileMetadata contains the rendered names of files as well as tags
//       render tags like "by" underneath images/videos
//       use "main" tag to find the thumbnail

function renderIndex(directoryPath, files, subdirectories) {
  let fileContents = "";
  if (fs.existsSync(`${INPUT_FOLDER}/${directoryPath}/index.md`)) {
    fileContents = fs.readFileSync(
      `${INPUT_FOLDER}/${directoryPath}/index.md`,
      "utf8"
    );
    fileContents = converter.makeHtml(fileContents);
  } else if (fs.existsSync(`${INPUT_FOLDER}/${directoryPath}/index.html`)) {
    fileContents = fs.readFileSync(
      `${INPUT_FOLDER}/${directoryPath}/index.html`,
      "utf8"
    );
  } else {
    fileContents = "";
  }
  let renderedFile = template.replace(/\{BODY\}/g, fileContents);
  const imageFiles = files.filter((file) =>
    [".jpg", ".jpeg", ".png"].includes(
      path.extname(file.name).toLocaleLowerCase()
    )
  );
  const videoFiles = files.filter((file) =>
    [".mov", ".mp4"].includes(path.extname(file.name).toLocaleLowerCase())
  );
  const otherFiles = files
    .filter((file) => !ALL_MEDIA_EXTENSIONS.includes(path.extname(file.name)))
    .filter((file) => !IGNORE_FOR_LIST.includes(path.basename(file.name)));
  const imageList = renderGallery(imageFiles);
  const videoList = renderVideoGallery(videoFiles);
  const fileList = otherFiles
    .map((file) => `<li><a href="${file.name}">${file.name}</a></li>`)
    .join("\n");
  const subdirList = subdirectories
    .map((dir) => {
      const name = renderName(dir.name);
      if (dir.thumbnail) {
        return `<li><a href="${dir.name}"><img src="${dir.name}/${dir.thumbnail}" class="thumbnail">${name}</a></li>`;
      } else {
        return `<li><a href="${dir.name}">${name}</a></li>`;
      }
    })
    .join("\n");
  const allFiles = videoList + imageList;
  const breadCrumb = renderBreadCrumbs(directoryPath);
  renderedFile = renderedFile.replace(/\{SUBDIRS\}/g, subdirList);
  renderedFile = renderedFile.replace(/\{FILES\}/g, allFiles);
  renderedFile = renderedFile.replace(/\{BREADCRUMB\}/g, breadCrumb);
  fs.writeFileSync(
    `${OUTPUT_FOLDER}/${directoryPath}/index.html`,
    renderedFile
  );
}

async function renderFile(filePath) {
  const extension = path.extname(filePath);
  const directory = path.dirname(filePath);
  const fileName = path.basename(filePath, extension);
  const split = fileName.split(TAG_CHARACTER);
  const baseFileName = split[0].trim();
  const renderedFileName = `${baseFileName}.${renderExtension(extension)}`;

  const tags = Object.fromEntries(
    split.slice(1).map((tag) => {
      const splitTag = tag.trim().split("=");
      const tagKey = splitTag[0];
      const value = splitTag[1] ?? true;
      return [tagKey, value];
    })
  );

  if (IGNORE_FOR_RENDER.includes(fileName)) {
    return;
  }

  // TODO: would it be faster & simpler to check the modified date of output files
  // and compare versus input? if input file is older than output file, then we know
  // we don't need to render the file

  // Compute hash of input file
  const hash = await checksumFile(`${INPUT_FOLDER}/${filePath}`);

  // Look up hash in cache
  if (cacheTable[hash] !== undefined) {
    // If the hash exists, return early
    console.log("HIT", "\t", filePath);
    return { name: renderedFileName, tags };
  }
  console.log("RENDERING", "\t", filePath);

  // TODO: in ffmpeg command below:
  //  - write to correct file
  //  - need to update links to the file. implies there needs to be an intermediate representation.
  //    `renderFile` could return a new filename, and then `renderDirectory` above could collect
  //    those new file names and pass them to `renderIndex`.

  // If the hash doesn't exist, render file
  if (extension === "md" || extension === "html") {
    const fileContents = fs.readFileSync(`${INPUT_FOLDER}/${filePath}`, "utf8");
    const breadCrumb = renderBreadCrumbs(filePath);

    let renderedFile = template.replace(/\{BODY\}/g, fileContents);
    renderedFile = renderedFile.replace(/\{BREADCRUMB\}/g, breadCrumb);

    fs.writeFileSync(
      renderedFileName,
      `${OUTPUT_FOLDER}/${directory}/${renderedFileName}`
    );
  } else if (VIDEO_EXTENSIONS.includes(extension)) {
    execFileSync("ffmpeg", [
      "-i",
      `${INPUT_FOLDER}/${filePath}`,
      "-c:v",
      "libx264",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "faststart",
      "-y",
      `${OUTPUT_FOLDER}/${directory}/${renderedFileName}`,
    ]);
  } else {
    fs.copyFileSync(
      `${INPUT_FOLDER}/${filePath}`,
      `${OUTPUT_FOLDER}/${directory}/${renderedFileName}`
    );
  }

  // Add to cache
  newCacheTable[hash] = filePath;

  return { name: renderedFileName, tags };
}

function renderExtension(extension) {
  extension = extension.toLowerCase().substring(1);
  if (extension === "md" || extension === "html") {
    return "html";
  } else if (VIDEO_EXTENSIONS.includes(extension)) {
    return "mp4";
  } else {
    return extension;
  }
}

function renderGallery(images, className) {
  if (images.length === 0) {
    return "";
  }

  className = className ?? "";
  const imageList = images.map(
    (image) =>
      `<div class='image ${className}' >
        <a href='${image.name}'>
          <img src='${image.name}'>
        </a>
        ${JSON.stringify(image.tags)}
      </div>`
  );
  return `
    <div class='image-gallery ${className}'>
      ${imageList.join("\n")}
    </div>
  `;
}

function renderVideoGallery(videos) {
  if (videos.length === 0) {
    return "";
  }

  const videoList = videos.map(
    (video) => `
    <div class='video'>
      <video controls>
        <source src="${video.name}" type="video/mp4">
      </video>
      ${JSON.stringify(video.tags)}
    </div>
  `
  );

  return `
    <div class='video-gallery'>
      ${videoList.join("\n")}
    </div>
  `;
}

function renderBreadCrumbs(filePath, skipLast = false) {
  const parts = filePath.split("/");
  let list = "";
  const length = skipLast ? parts.length - 1 : parts.length;
  list += `<li><a href="/">home</a></li>`;
  for (let i = 1; i < length; i++) {
    const url = parts.slice(0, i + 1).join("/");
    const name = renderName(parts[i]);
    list += `<li><a href="${url}">${name}</a></li>`;
  }
  return `<ul>${list}</ul>`;
}

function renderName(file) {
  const name = file.split("-").join(" ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

async function main() {
  await renderDirectory("");
  fs.copyFileSync(CSS_FILE, `${OUTPUT_FOLDER}/${CSS_FILE}`);
  writeCache();
}

main();
