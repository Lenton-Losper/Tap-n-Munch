import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { storage } from './config'

/**
 * Upload an image file to Firebase Storage
 * @param file - The file to upload
 * @param path - Storage path (e.g., 'menu-items/item-123.jpg')
 * @returns The download URL of the uploaded file
 */
export async function uploadImage(
  file: File,
  path: string
): Promise<string> {
  if (!storage) {
    throw new Error('Firebase Storage is not initialized')
  }

  // Validate file type
  if (!file.type.startsWith('image/')) {
    throw new Error('File must be an image')
  }

  // Validate file size (max 5MB)
  const maxSize = 5 * 1024 * 1024 // 5MB
  if (file.size > maxSize) {
    throw new Error('Image size must be less than 5MB')
  }

  try {
    // Create a reference to the file location
    const storageRef = ref(storage, path)
    
    // Upload the file
    await uploadBytes(storageRef, file)
    
    // Get the download URL
    const downloadURL = await getDownloadURL(storageRef)
    
    return downloadURL
  } catch (error: any) {
    console.error('Error uploading image:', error)
    throw new Error(error.message || 'Failed to upload image')
  }
}

/**
 * Upload a menu item image
 * @param file - The image file
 * @param restaurantId - Restaurant ID
 * @param itemId - Menu item ID (optional, for existing items)
 * @returns The download URL of the uploaded image
 */
export async function uploadMenuItemImage(
  file: File,
  restaurantId: string,
  itemId?: string
): Promise<string> {
  // Generate a unique filename
  const timestamp = Date.now()
  const randomString = Math.random().toString(36).substring(2, 15)
  const fileExtension = file.name.split('.').pop() || 'jpg'
  const filename = itemId 
    ? `menu-items/${restaurantId}/${itemId}-${timestamp}.${fileExtension}`
    : `menu-items/${restaurantId}/${timestamp}-${randomString}.${fileExtension}`
  
  return uploadImage(file, filename)
}

/**
 * Delete an image from Firebase Storage
 * @param imageUrl - The full URL of the image to delete
 */
export async function deleteImage(imageUrl: string): Promise<void> {
  if (!storage) {
    throw new Error('Firebase Storage is not initialized')
  }

  try {
    // Extract the path from the URL
    // Firebase Storage URLs look like: https://firebasestorage.googleapis.com/v0/b/...
    // We need to extract the path from the URL
    const url = new URL(imageUrl)
    const pathMatch = url.pathname.match(/\/v0\/b\/[^/]+\/o\/(.+)/)
    
    if (!pathMatch) {
      throw new Error('Invalid image URL')
    }

    // Decode the path (Firebase Storage URLs are URL-encoded)
    const encodedPath = pathMatch[1]
    const decodedPath = decodeURIComponent(encodedPath)
    
    // Create a reference and delete
    const storageRef = ref(storage, decodedPath)
    await deleteObject(storageRef)
  } catch (error: any) {
    console.error('Error deleting image:', error)
    throw new Error(error.message || 'Failed to delete image')
  }
}

