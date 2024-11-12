import BackgroundService from 'react-native-background-actions';
import { type AxiosError, type AxiosInstance } from 'axios';
import { Image as CompressImage } from 'react-native-compressor';
import FormData from 'form-data';
import { Platform } from 'react-native';

interface UploadResponse {
  data: Data;
  success: boolean;
  message: string;
  errorCode: string;
}
interface ErrorResponse {
  error: object;
  status: number;
}
interface Data {
  accessUrl: string;
  photoId: string;
  status: Status;
}

interface Status {
  code: string;
  message: string;
}

type Extras = {
  [key: string]: string;
};

interface Image {
  photoId: string;
  status: 'draft' | 'uploaded' | 'failed';
  uri: string;
  type: string;
  fileName: string;
  extras: Extras;
}
interface UploadOptions {
  axiosInstance: AxiosInstance;
  images: Image[];
  url: string;
  batchSize?: number;
  maxRetries?: number;
  imageCompression?: boolean;
}

interface IFailure {
  onFailure?: (
    error: ErrorResponse | AxiosError,
    photoId: string | undefined
  ) => void;
}
interface ISuccess {
  onSuccess?: (data: UploadResponse) => void;
}

interface TaskData {
  images: Image[];
  batchSize: number;
  onSuccess: ISuccess['onSuccess'];
  onFailure: IFailure['onFailure'];
  url: string;
  maxRetries: number;
  imageCompression: boolean;
  axiosInstance: AxiosInstance;
  onBatchComplete: (results: any[], batchCount: number) => void;
  onServiceEnd: () => void;
}

// Queue to store images while an upload is in progress
let queuedImages: Image[] = [];
let failedImages: Image[] = [];

const compressImage = async (uri: string) => {
  try {
    return await CompressImage.compress(uri);
  } catch (e) {
    return uri;
  }
};

const uploadImage = async (
  image: Image,
  url: string,
  imageCompression: boolean,
  axiosInstance: AxiosInstance
) => {
  let imageUri;
  if (imageCompression) {
    imageUri = await compressImage(image.uri);
  } else {
    imageUri = image.uri;
  }

  const formData = new FormData();
  formData.append('file', {
    uri: imageUri,
    type: image.type || 'image/jpeg',
    name: image.fileName || 'photo.jpg',
  });
  // Dynamically append key-value pairs from the extras object to formData
  for (const [key, value] of Object.entries(image?.extras)) {
    formData.append(key, value);
  }
  return await axiosInstance.post(url, formData, {
    headers: {
      'content-type': 'multipart/form-data',
    },
  });
};

export const startBackgroundUpload = async ({
  uploadOptions,
  onSuccess,
  onFailure,
  onBatchComplete,
  onServiceStart,
  onServiceEnd,
}: {
  uploadOptions: UploadOptions;
  onSuccess: ISuccess['onSuccess'];
  onFailure: IFailure['onFailure'];
  onBatchComplete?: (result: any, batchCount: number) => void;
  onServiceStart?: () => void;
  onServiceEnd?: () => void;
}) => {
  const {
    images,
    url,
    batchSize = 10,
    maxRetries = 3,
    imageCompression = true,
    axiosInstance,
  } = uploadOptions;
  const isRunning = BackgroundService.isRunning();

  if (isRunning) {
    // If the upload task is running, queue the new images
    queuedImages.push(...images);
    return;
  }

  const options = {
    taskName: 'Upload Images',
    taskTitle: 'Uploading Images',
    taskDesc: 'Please wait while images are uploading',
    taskIcon: {
      name: 'ic_launcher',
      type: 'mipmap',
    },
    parameters: {
      images,
      batchSize,
      maxRetries,
      url,
      onSuccess,
      onFailure,
      onBatchComplete,
      imageCompression,
      onServiceEnd,
      axiosInstance,
    },
  };

  // @ts-ignore
  await BackgroundService.start(uploadTask, options);
  if (Platform.OS === 'ios') {
    onServiceStart && onServiceStart();
  }
};

// Upload task that will run in the background
const uploadTask = async (taskData: TaskData) => {
  if (!taskData) {
    return;
  }
  const {
    images,
    batchSize,
    onSuccess,
    onFailure,
    url,
    onBatchComplete,
    maxRetries,
    imageCompression,
    onServiceEnd,
    axiosInstance,
  } = taskData;

  for (let i = 0; i < images.length; i += batchSize) {
    const batch = images.slice(i, i + batchSize);
    const uploadPromises = batch.map((image: Image) => {
      const startTime = Date.now();
      return uploadImage(image, url, imageCompression, axiosInstance)
        .then((response) => {
          const endTime = Date.now();
          // Image upload successful
          onSuccess &&
            onSuccess({
              ...response.data,
              photoId: image?.photoId,
            });
          return {
            photoId: image?.photoId,
            startTime,
            endTime,
          };
        })
        .catch((error) => {
          // Image upload failed
          onFailure && onFailure(getError(error), image?.photoId);
          failedImages.push(image);
          return new Promise((_, reject) => {
            reject({
              error: error?.message || 'Unknown error',
              photoId: image?.photoId,
            });
          });
        });
    });
    try {
      const currentBatch = Math.floor(i / batchSize) + 1;
      // Wait for all images in the batch to be uploaded
      const result = await Promise.allSettled(uploadPromises);
      onBatchComplete && onBatchComplete(result, currentBatch);
    } catch (error) {
      console.error('Error uploading batch:', error);
    }
  }
  // When the upload task finishes, process the queued images if any
  if (queuedImages.length > 0) {
    let queuedImagesCopy = [...queuedImages];
    queuedImages = [];

    for (let i = 0; i < queuedImagesCopy.length; i += batchSize) {
      const batch = queuedImagesCopy.slice(i, i + batchSize);
      const uploadPromises = batch.map((image) => {
        return uploadImage(image, url, imageCompression, axiosInstance)
          .then((response) => {
            // Image upload successful
            onSuccess &&
              onSuccess({
                ...response.data,
                photoId: image?.photoId,
              });
            return response;
          })
          .catch((error) => {
            onFailure && onFailure(getError(error), image?.photoId);
            failedImages.push(image);
            return new Promise((_, reject) => {
              reject({
                error: error?.message || 'Unknown error',
                photoId: image?.photoId,
              });
            });
          });
      });
      try {
        const currentBatch = Math.floor(i / batchSize) + 1;
        // Wait for all images in the batch to be uploaded
        const result = await Promise.allSettled(uploadPromises);
        onBatchComplete && onBatchComplete(result, currentBatch);
      } catch (error) {
        console.error('Error uploading batch:', error);
      }
    }
    queuedImagesCopy = [];
  }

  // failure images
  if (failedImages.length > 0) {
    let failedImagesCopy = [];
    let retryCount = 0;
    while (failedImages.length > 0 && retryCount < maxRetries) {
      console.log(`Retrying failed images: ${retryCount + 1}`);
      failedImagesCopy = [...failedImages];
      failedImages = [];
      for (let i = 0; i < failedImagesCopy.length; i += batchSize) {
        const batch = failedImagesCopy.slice(i, i + batchSize);
        const uploadPromises = batch.map((image) => {
          return uploadImage(image, url, imageCompression, axiosInstance)
            .then((response) => {
              // Image upload successful
              onSuccess &&
                onSuccess({
                  ...response.data,
                  photoId: image?.photoId,
                });
              return response;
            })
            .catch((error) => {
              onFailure && onFailure(getError(error), image?.photoId);
              failedImages.push(image);
              return new Promise((_, reject) => {
                reject({
                  error: error?.message || 'Unknown error',
                  photoId: image?.photoId,
                  retryCount,
                });
              });
            });
        });
        try {
          const currentBatch = Math.floor(i / batchSize) + 1;
          const result = await Promise.allSettled(uploadPromises);
          onBatchComplete && onBatchComplete(result, currentBatch);
        } catch (error) {
          console.error('Error uploading batch:', error);
        }
      }
      retryCount++;
    }
    failedImagesCopy = [];
  }

  // Stop the background service after completing all uploads
  await BackgroundService.stop();
  if (Platform.OS === 'ios') {
    onServiceEnd && onServiceEnd();
  }
  // Queue to store images while an upload is in progress
  queuedImages = [];
  failedImages = [];
  console.log('Stopping service');
};

const getError = (error: AxiosError): ErrorResponse | AxiosError => {
  if (error?.response) {
    return {
      error: error?.response?.data ?? {},
      status: error?.response?.status ?? 0,
    };
  }
  return error;
};

export function multiply(a: number, b: number): Promise<number> {
  return Promise.resolve(a * b);
}
